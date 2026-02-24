use std::sync::Arc;

use axum::{
    Router,
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::{AppState, Board, ImageRef, Vec2};

type AppResult<T> = Result<T, (StatusCode, String)>;

fn err(status: StatusCode, msg: impl ToString) -> (StatusCode, String) {
    (status, msg.to_string())
}

// ── Board endpoints ─────────────────────────────────────────────────

async fn list_boards(State(state): State<Arc<AppState>>) -> Json<Vec<BoardSummary>> {
    let boards = state.boards.lock().unwrap();
    let summaries: Vec<BoardSummary> = boards
        .values()
        .map(|b| BoardSummary {
            id: b.id,
            name: b.name.clone(),
            image_count: b.images.len(),
            updated_at: b.updated_at.to_rfc3339(),
        })
        .collect();
    Json(summaries)
}

#[derive(Serialize)]
struct BoardSummary {
    id: Uuid,
    name: String,
    image_count: usize,
    updated_at: String,
}

async fn get_board(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Board>> {
    let boards = state.boards.lock().unwrap();
    boards
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Board not found"))
}

#[derive(Deserialize)]
struct CreateBoard {
    name: String,
}

async fn create_board(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateBoard>,
) -> AppResult<Json<Board>> {
    let board = Board::new(body.name);
    let _ = state.save_board(&board);
    let mut boards = state.boards.lock().unwrap();
    boards.insert(board.id, board.clone());
    state.broadcast(&serde_json::json!({"type": "board_created", "payload": {"id": board.id, "name": &board.name}}).to_string());
    Ok(Json(board))
}

async fn update_board(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(body): Json<Board>,
) -> AppResult<Json<Board>> {
    let mut boards = state.boards.lock().unwrap();
    if !boards.contains_key(&id) {
        return Err(err(StatusCode::NOT_FOUND, "Board not found"));
    }
    let _ = state.save_board(&body);
    boards.insert(id, body.clone());
    state.broadcast(&serde_json::json!({"type": "board_loaded", "payload": {"id": id}}).to_string());
    Ok(Json(body))
}

async fn delete_board(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut boards = state.boards.lock().unwrap();
    if boards.remove(&id).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "Board not found"));
    }
    let path = state.config.boards_dir.join(format!("{}.json", id));
    let _ = std::fs::remove_file(path);
    Ok(StatusCode::NO_CONTENT)
}

// ── Image endpoints ─────────────────────────────────────────────────

async fn list_images(State(state): State<Arc<AppState>>) -> AppResult<Json<Vec<ImageRef>>> {
    let active = state.active_board_id.lock().unwrap();
    let boards = state.boards.lock().unwrap();
    if let Some(id) = *active {
        if let Some(board) = boards.get(&id) {
            return Ok(Json(board.images.clone()));
        }
    }
    Ok(Json(vec![]))
}

#[derive(Deserialize)]
struct AddImageBody {
    url: Option<String>,
    tags: Option<Vec<String>>,
    position: Option<Vec2>,
    source_query: Option<String>,
}

async fn add_image(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> AppResult<Json<ImageRef>> {
    // Try JSON body first
    let add: AddImageBody = serde_json::from_slice(&body)
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("Invalid JSON: {}", e)))?;

    let url = add.url.ok_or_else(|| err(StatusCode::BAD_REQUEST, "url is required"))?;

    // Download image
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Download failed: {}", e)))?;

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();

    let ext = match content_type.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };

    let image_bytes = resp
        .bytes()
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, format!("Read failed: {}", e)))?;

    let id = Uuid::new_v4();
    let filename = format!("{}.{}", id, ext);
    let file_path = state.config.images_dir.join(&filename);
    std::fs::write(&file_path, &image_bytes)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("Write failed: {}", e)))?;

    let image_ref = ImageRef {
        id,
        filename: filename.clone(),
        original_url: Some(url),
        local_path: format!("images/{}", filename),
        position: add.position.unwrap_or(Vec2 { x: 0.0, y: 0.0 }),
        scale: 1.0,
        tags: add.tags.unwrap_or_default(),
        source_query: add.source_query,
        added_at: chrono::Utc::now(),
        dimensions: None,
        opacity: 1.0,
        z_index: 0,
    };

    // Add to active board
    {
        let active = state.active_board_id.lock().unwrap();
        let mut boards = state.boards.lock().unwrap();
        if let Some(board_id) = *active {
            if let Some(board) = boards.get_mut(&board_id) {
                board.images.push(image_ref.clone());
                board.updated_at = chrono::Utc::now();
                let _ = state.save_board(board);
            }
        }
    }

    state.broadcast(&serde_json::json!({"type": "image_added", "payload": &image_ref}).to_string());
    Ok(Json(image_ref))
}

async fn add_image_upload(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> AppResult<Json<ImageRef>> {
    let mut image_bytes = Vec::new();
    let mut ext = "png".to_string();
    let mut tags: Vec<String> = vec![];

    while let Some(field) = multipart.next_field().await.map_err(|e: axum::extract::multipart::MultipartError| err(StatusCode::BAD_REQUEST, e.to_string()))? {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            if let Some(ct) = field.content_type() {
                ext = match ct {
                    "image/jpeg" | "image/jpg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => "png",
                }.to_string();
            }
            image_bytes = field.bytes().await.map_err(|e: axum::extract::multipart::MultipartError| err(StatusCode::BAD_REQUEST, e.to_string()))?.to_vec();
        } else if name == "tags" {
            let text: String = field.text().await.map_err(|e: axum::extract::multipart::MultipartError| err(StatusCode::BAD_REQUEST, e.to_string()))?;
            tags = text.split(',').map(|s: &str| s.trim().to_string()).filter(|s: &String| !s.is_empty()).collect();
        }
    }

    if image_bytes.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "No file uploaded"));
    }

    let id = Uuid::new_v4();
    let filename = format!("{}.{}", id, ext);
    let file_path = state.config.images_dir.join(&filename);
    std::fs::write(&file_path, &image_bytes)
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, format!("Write failed: {}", e)))?;

    let image_ref = ImageRef {
        id,
        filename: filename.clone(),
        original_url: None,
        local_path: format!("images/{}", filename),
        position: Vec2 { x: 0.0, y: 0.0 },
        scale: 1.0,
        tags,
        source_query: None,
        added_at: chrono::Utc::now(),
        dimensions: None,
        opacity: 1.0,
        z_index: 0,
    };

    {
        let active = state.active_board_id.lock().unwrap();
        let mut boards = state.boards.lock().unwrap();
        if let Some(board_id) = *active {
            if let Some(board) = boards.get_mut(&board_id) {
                board.images.push(image_ref.clone());
                board.updated_at = chrono::Utc::now();
                let _ = state.save_board(board);
            }
        }
    }

    state.broadcast(&serde_json::json!({"type": "image_added", "payload": &image_ref}).to_string());
    Ok(Json(image_ref))
}

async fn get_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ImageRef>> {
    let active = state.active_board_id.lock().unwrap();
    let boards = state.boards.lock().unwrap();
    if let Some(board_id) = *active {
        if let Some(board) = boards.get(&board_id) {
            if let Some(img) = board.images.iter().find(|i| i.id == id) {
                return Ok(Json(img.clone()));
            }
        }
    }
    Err(err(StatusCode::NOT_FOUND, "Image not found"))
}

async fn serve_image_file(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, [(String, String); 2], Vec<u8>)> {
    let active = state.active_board_id.lock().unwrap();
    let boards = state.boards.lock().unwrap();
    let img = if let Some(board_id) = *active {
        boards.get(&board_id).and_then(|b| b.images.iter().find(|i| i.id == id).cloned())
    } else {
        None
    };
    let img = img.ok_or_else(|| err(StatusCode::NOT_FOUND, "Image not found"))?;

    let file_path = state.config.images_dir.join(&img.filename);
    let bytes = std::fs::read(&file_path)
        .map_err(|e| err(StatusCode::NOT_FOUND, format!("File not found: {}", e)))?;

    let ct = if img.filename.ends_with(".jpg") || img.filename.ends_with(".jpeg") {
        "image/jpeg"
    } else if img.filename.ends_with(".gif") {
        "image/gif"
    } else if img.filename.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };

    Ok((
        StatusCode::OK,
        [
            ("content-type".to_string(), ct.to_string()),
            ("cache-control".to_string(), "public, max-age=86400".to_string()),
        ],
        bytes,
    ))
}

#[derive(Deserialize)]
struct UpdateImage {
    position: Option<Vec2>,
    scale: Option<f64>,
    tags: Option<Vec<String>>,
    opacity: Option<f64>,
    z_index: Option<i32>,
}

async fn update_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateImage>,
) -> AppResult<Json<ImageRef>> {
    let active = state.active_board_id.lock().unwrap();
    let mut boards = state.boards.lock().unwrap();
    if let Some(board_id) = *active {
        if let Some(board) = boards.get_mut(&board_id) {
            if let Some(img) = board.images.iter_mut().find(|i| i.id == id) {
                if let Some(pos) = body.position { img.position = pos; }
                if let Some(scale) = body.scale { img.scale = scale; }
                if let Some(tags) = body.tags { img.tags = tags; }
                if let Some(opacity) = body.opacity { img.opacity = opacity; }
                if let Some(z_index) = body.z_index { img.z_index = z_index; }
                let result = img.clone();
                board.updated_at = chrono::Utc::now();
                let _ = state.save_board(board);
                state.broadcast(&serde_json::json!({"type": "image_updated", "payload": &result}).to_string());
                return Ok(Json(result));
            }
        }
    }
    Err(err(StatusCode::NOT_FOUND, "Image not found"))
}

async fn delete_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let active = state.active_board_id.lock().unwrap();
    let mut boards = state.boards.lock().unwrap();
    if let Some(board_id) = *active {
        if let Some(board) = boards.get_mut(&board_id) {
            let before = board.images.len();
            board.images.retain(|i| i.id != id);
            if board.images.len() < before {
                board.updated_at = chrono::Utc::now();
                let _ = state.save_board(board);
                state.broadcast(&serde_json::json!({"type": "image_removed", "payload": {"id": id}}).to_string());
                return Ok(StatusCode::NO_CONTENT);
            }
        }
    }
    Err(err(StatusCode::NOT_FOUND, "Image not found"))
}

// ── Search endpoint ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search_images(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Json<Vec<ImageRef>> {
    let q = query.q.to_lowercase();
    let boards = state.boards.lock().unwrap();
    let mut results = Vec::new();
    for board in boards.values() {
        for img in &board.images {
            let matches = img.tags.iter().any(|t| t.to_lowercase().contains(&q))
                || img.source_query.as_ref().is_some_and(|s| s.to_lowercase().contains(&q))
                || img.filename.to_lowercase().contains(&q);
            if matches {
                results.push(img.clone());
            }
        }
    }
    Json(results)
}

// ── Health / Stats ──────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct Stats {
    board_count: usize,
    total_images: usize,
    storage_bytes: u64,
}

async fn stats(State(state): State<Arc<AppState>>) -> Json<Stats> {
    let boards = state.boards.lock().unwrap();
    let total_images: usize = boards.values().map(|b| b.images.len()).sum();

    let storage = walkdir(&state.config.images_dir);

    Json(Stats {
        board_count: boards.len(),
        total_images,
        storage_bytes: storage,
    })
}

fn walkdir(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

// ── Router ──────────────────────────────────────────────────────────

pub fn routes(_state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Boards
        .route("/boards", get(list_boards).post(create_board))
        .route("/boards/{id}", get(get_board).put(update_board).delete(delete_board))
        // Images
        .route("/images", get(list_images).post(add_image))
        .route("/images/upload", post(add_image_upload))
        .route("/images/{id}", get(get_image).put(update_image).delete(delete_image))
        .route("/images/{id}/file", get(serve_image_file))
        // Search
        .route("/search", get(search_images))
        // System
        .route("/health", get(health))
        .route("/stats", get(stats))
}
