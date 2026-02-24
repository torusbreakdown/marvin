mod state;
mod api;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;
use axum::{Router, routing::get};
use tower_http::services::ServeDir;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _data_dir = dirs::data_dir();
    let config = state::Config::load()?;

    // Ensure directories exist
    std::fs::create_dir_all(&config.images_dir)?;
    std::fs::create_dir_all(&config.boards_dir)?;

    let app_state = Arc::new(state::AppState::load(&config)?);

    let api_routes = api::routes(app_state.clone());

    let static_dir = std::env::current_exe()?
        .parent()
        .unwrap()
        .join("static");
    // Fall back to ./static relative to cwd
    let static_dir = if static_dir.exists() {
        static_dir
    } else {
        std::path::PathBuf::from("static")
    };

    let app = Router::new()
        .nest("/api", api_routes)
        .route("/ws", get(ws::websocket_handler))
        .fallback_service(ServeDir::new(&static_dir))
        .layer(CorsLayer::permissive())
        .with_state(app_state.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();

    let url = format!("http://localhost:{}", actual_port);
    eprintln!("ncpure-web listening at {}", url);

    // Open browser (best-effort)
    let _ = open::that(&url);

    axum::serve(listener, app).await?;
    Ok(())
}

mod dirs {
    use std::path::PathBuf;

    pub fn data_dir() -> PathBuf {
        if let Ok(d) = std::env::var("NCPURE_DATA_DIR") {
            return PathBuf::from(d);
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("ncpure")
    }
}
