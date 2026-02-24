use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Config ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub images_dir: PathBuf,
    pub boards_dir: PathBuf,
    pub ai_bridge_url: Option<String>,
}

impl Config {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = super::dirs::data_dir();
        let config_path = data_dir.join("config.toml");

        let mut port: u16 = 9850;
        let mut ai_bridge_url: Option<String> = None;

        if config_path.exists() {
            let text = std::fs::read_to_string(&config_path)?;
            let table: toml::Table = text.parse()?;
            if let Some(p) = table.get("port").and_then(|v| v.as_integer()) {
                port = p as u16;
            }
            if let Some(u) = table.get("ai_bridge_url").and_then(|v| v.as_str()) {
                ai_bridge_url = Some(u.to_string());
            }
        }

        Ok(Config {
            port,
            images_dir: data_dir.join("images"),
            boards_dir: data_dir.join("boards"),
            data_dir,
            ai_bridge_url,
        })
    }
}

// ── Data Model ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageRef {
    pub id: Uuid,
    pub filename: String,
    pub original_url: Option<String>,
    pub local_path: String,

    pub position: Vec2,
    pub scale: f64,

    pub tags: Vec<String>,
    pub source_query: Option<String>,
    pub added_at: DateTime<Utc>,
    pub dimensions: Option<(u32, u32)>,

    pub opacity: f64,
    pub z_index: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    pub id: Uuid,
    pub name: String,
    pub images: Vec<ImageRef>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Board {
    pub fn new(name: String) -> Self {
        let now = Utc::now();
        Board {
            id: Uuid::new_v4(),
            name,
            images: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

// ── Application State ───────────────────────────────────────────────

pub struct AppState {
    pub config: Config,
    pub boards: Mutex<HashMap<Uuid, Board>>,
    pub active_board_id: Mutex<Option<Uuid>>,
    pub ws_tx: tokio::sync::broadcast::Sender<String>,
}

impl AppState {
    pub fn load(config: &Config) -> Result<Self, Box<dyn std::error::Error>> {
        let mut boards = HashMap::new();

        // Load boards from boards/ directory
        if config.boards_dir.exists() {
            for entry in std::fs::read_dir(&config.boards_dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "json") {
                    let text = std::fs::read_to_string(&path)?;
                    let board: Board = serde_json::from_str(&text)?;
                    boards.insert(board.id, board);
                }
            }
        }

        // Load legacy references.json into a default board
        let refs_path = config.data_dir.join("references.json");
        if refs_path.exists() && boards.is_empty() {
            let text = std::fs::read_to_string(&refs_path)?;
            let images: Vec<ImageRef> = serde_json::from_str(&text)?;
            let mut board = Board::new("Default".into());
            board.images = images;
            boards.insert(board.id, board);
        }

        // Create a default board if none exist
        let active_id = if boards.is_empty() {
            let board = Board::new("Default".into());
            let id = board.id;
            boards.insert(id, board);
            Some(id)
        } else {
            boards.keys().next().copied()
        };

        let (ws_tx, _) = tokio::sync::broadcast::channel(256);

        Ok(AppState {
            config: Config::load()?,
            boards: Mutex::new(boards),
            active_board_id: Mutex::new(active_id),
            ws_tx,
        })
    }

    pub fn save_board(&self, board: &Board) -> Result<(), Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&self.config.boards_dir)?;
        let path = self.config.boards_dir.join(format!("{}.json", board.id));
        let json = serde_json::to_string_pretty(board)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub fn broadcast(&self, msg: &str) {
        let _ = self.ws_tx.send(msg.to_string());
    }
}
