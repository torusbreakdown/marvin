# ncpure: Open Source PureRef Alternative with AI-Powered Web Interface

## What We're Building

**ncpure** is an open-source reference image management tool designed as an alternative to [PureRef](https://www.pureref.com/)—the popular "infinite canvas" reference board application used by digital artists, concept artists, and 3D modelers to collect, organize, and view reference images while working.

Unlike PureRef (which is proprietary, standalone, and costs a one-time €39 fee), ncpure is:
- **Open source** (Rust + TypeScript)
- **Multi-interface**: Existing TUI (terminal UI) client + new web browser interface
- **AI-augmented**: Integrates with AI image search to automatically find relevant references
- **Networked**: Daemon-based architecture allowing multiple clients (terminal, browser, even multiple machines) to connect simultaneously

## The Problem Space

Digital artists need a "second monitor" tool that:
1. **Collects** reference images from the web without manual downloading/saving
2. **Organizes** them on an infinite canvas (position, scale, arrange freely)
3. **Persists** sessions across reboots (save/load boards)
4. **Stays out of the way** (minimal UI chrome, always on top options)
5. **Is accessible** from anywhere (web interface means tablets, laptops, etc.)

PureRef does this well but lacks:
- Open source extensibility
- AI-assisted image discovery
- Remote/multi-device access
- Terminal-based workflows

## Architecture Overview

ncpure uses a **client-server model** where a headless daemon manages state and storage, while multiple clients (TUI, web browser) connect via HTTP/WebSocket.

```
┌─────────────────────────────────────────────────────────────┐
│                       ncpure Daemon                         │
│  (Rust - Axum HTTP server + WebSocket broadcaster)          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  HTTP API    │  │   WebSocket  │  │  Filesystem     │   │
│  │  (REST)      │  │   (Events)   │  │  (JSON + imgs)  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘   │
└─────────┼─────────────────┼──────────────────┼────────────┘
          │                 │                  │
    ┌─────▼─────┐    ┌──────▼──────┐    ┌──────▼──────┐
    │ Web Client│    │  TUI Client │    │  AI Bridge  │
    │ (Browser) │    │  (ncurses)  │    │ (External)  │
    └───────────┘    └─────────────┘    └─────────────┘
```

## Core Components

### 1. The Daemon (ncpure-web)

The central brain. A Rust binary using [Axum](https://github.com/tokio-rs/axum) that:
- Serves a static HTML/JS frontend
- Manages REST API endpoints
- Broadcasts real-time updates via WebSocket
- Watches filesystem for changes
- Opens your default browser on startup

**Why Axum instead of Tauri/Electron?**
- You already have a TUI client and plan to have an AI bridge
- Adding Electron/Tauri creates a third heavyweight process
- Browsers are already optimized for image rendering and canvas performance
- Single binary deployment (frontend can be embedded or served as static files)

### 2. The Web Client

A vanilla TypeScript application (no React/Vue build step, or optional esbuild) using HTML5 Canvas:

**Features:**
- **Infinite canvas** with pan (middle mouse / space+drag) and zoom (scroll)
- **Drag-to-arrange** images freely
- **Selection**: Click to select, rubber-band multi-select
- **Image loading**: Lazy load from daemon, cache in memory
- **Search bar**: Query local database + trigger AI image search
- **Context menus**: Right-click for delete, copy path, tags

**Hotkeys** (matching PureRef conventions):
- `Ctrl+N` - New board
- `Ctrl+O` - Open/import image(s)
- `Ctrl+S` - Save (auto-save happens anyway)
- `Ctrl+F` - Focus search bar
- `Ctrl+Z` - Undo last action
- `Delete` - Remove selected images (keeps file by default)
- `Tab` - Toggle UI chrome (minimal mode)
- `F11` - Fullscreen

### 3. The TUI Client (Existing)

Already built or planned—an ncurses-based terminal interface for:
- Keyboard-heavy workflows
- SSH access from remote machines
- Minimal resource usage

Connects via WebSocket to receive the same real-time updates as the web client.

### 4. The AI Bridge (External)

A separate process (Python/Node/whatever) that:
- Accepts text queries from the daemon
- Searches the web for relevant images (using search APIs + scraping)
- Downloads candidates to a staging area
- Optionally runs local vision models for auto-tagging
- Returns results to daemon via HTTP callback

**Separation of concerns**: The AI bridge is optional. The daemon works fine without it for manual image management.

## Data Model

### Filesystem Layout

```
~/ncpure/                     # Data directory (configurable)
├── references.json           # Master database (array of ImageRef)
├── images/                   # Actual image files (UUID-named)
│   ├── a1b2c3d4-e5f6-7890-abcd-ef1234567890.jpg
│   ├── b2c3d4e5-f6g7-8901-bcde-f12345678901.png
│   └── ...
├── boards/                   # (Future) Multiple named boards
│   ├── character_concept_01.json
│   └── environment_mood.json
└── config.toml               # Daemon settings (port, AI endpoint, etc.)
```

### Schema

```rust
// references.json
#[derive(Serialize, Deserialize)]
struct ImageRef {
    id: Uuid,                    // v4 UUID
    filename: String,            // UUID.ext in images/ dir
    original_url: Option<String>, // Where it came from (if web)
    local_path: PathBuf,         // Relative to data dir
    
    // Canvas position (stored as normalized 0-1 or pixels?)
    position: Vec2,              // { x: f32, y: f32 }
    scale: f32,                  // 1.0 = original size
    
    // Metadata
    tags: Vec<String>,           // User-defined + AI auto-tags
    source_query: Option<String>, // The search that found it
    added_at: DateTime<Utc>,
    dimensions: Option<(u32, u32)>, // Width, height in pixels
    
    // Display
    opacity: f32,                // 0.0 - 1.0 (for fade effects)
    z_index: i32,                // Stacking order
}

type Board = Vec<ImageRef>;
```

## API Endpoints

### REST API

```rust
// Board Management
GET    /api/boards              // List all saved boards
GET    /api/boards/:id          // Load specific board
POST   /api/boards              // Create new board
PUT    /api/boards/:id          // Save/update board
DELETE /api/boards/:id          // Delete board

// Images
GET    /api/images              // List all images on current board
POST   /api/images              // Add image (multipart upload or JSON with URL)
GET    /api/images/:id          // Get metadata
GET    /api/images/:id/file     // Serve actual image bytes (with caching headers)
PUT    /api/images/:id          // Update position, scale, tags, etc.
DELETE /api/images/:id          // Remove from board (keep file or purge)

// Search
GET    /api/search?q=forest+cabin&mood=dark  // Local search first
// If ?ai=true, also triggers AI bridge, streams results via WebSocket

// System
GET    /api/health              // Daemon status
GET    /api/stats               // Image count, storage used, etc.
```

### WebSocket Events

Real-time synchronization between clients:

```typescript
// Client -> Server
interface ClientMessage {
  type: 'subscribe' | 'ping' | 'request_lock';
  client_id: string;
}

// Server -> Client (broadcast to all connected clients)
interface ServerMessage {
  type: 'image_added' | 'image_removed' | 'image_moved' | 
        'image_updated' | 'board_loaded' | 'ai_result';
  payload: any;
  timestamp: string;
  client_origin?: string;  // Which client made the change
}

// Example: Image moved by TUI client, broadcast to Web client
{
  type: 'image_moved',
  payload: {
    id: 'a1b2c3d4...',
    new_position: { x: 100.5, y: 200.0 },
    new_scale: 1.5
  },
  timestamp: '2024-01-15T10:30:00Z',
  client_origin: 'tui-ssh-session-01'
}
```

## Frontend Implementation Details

### Canvas Rendering

```typescript
class ReferenceCanvas {
  private ctx: CanvasRenderingContext2D;
  private viewport: Viewport = { x: 0, y: 0, zoom: 1.0 };
  private images: Map<string, CanvasImage>; // id -> { ref, img_element, loaded }
  private selected: Set<string> = new Set();
  
  // Rendering loop
  render() {
    // Clear
    this.ctx.fillStyle = '#2a2a2a'; // Dark gray like PureRef
    this.ctx.fillRect(0, 0, width, height);
    
    // Draw grid (optional, when zoomed out)
    this.drawGrid();
    
    // Draw images (sorted by z-index)
    for (const img of this.sortedImages()) {
      this.drawImage(img);
    }
    
    // Draw selection boxes
    for (const id of this.selected) {
      this.drawSelectionHighlight(id);
    }
  }
  
  // Coordinate transforms (screen <-> world)
  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.viewport.x) / this.viewport.zoom,
      y: (sy - this.viewport.y) / this.viewport.zoom
    };
  }
}
```

### Image Loading Strategy

1. **Metadata first**: Load `references.json`, show placeholder rectangles
2. **Visible prioritization**: Load images in current viewport first
3. **Lazy offscreen**: Load images within 2x viewport bounds
4. **Memory management**: LRU cache for image elements, drop from DOM if >100 images
5. **Thumbnail generation**: Daemon creates 256x256 thumbs on ingest for fast loading

## Startup Flow

```rust
#[tokio::main]
async fn main() -> Result<()> {
    // 1. Load config from ~/ncpure/config.toml or env vars
    let config = Config::load()?;
    
    // 2. Ensure data directories exist
    fs::create_dir_all(&config.data_dir)?;
    fs::create_dir_all(&config.images_dir)?;
    
    // 3. Load or initialize references.json
    let state = Arc::new(Mutex::new(BoardState::load(&config)?));
    
    // 4. Set up filesystem watcher (notify crate)
    let mut watcher = notify::recommended_watcher(move |res| {
        // Handle external file changes
    })?;
    watcher.watch(&config.images_dir, RecursiveMode::NonRecursive)?;
    
    // 5. Build Axum router with API + static file serving
    let app = Router::new()
        .nest("/api", api_routes())
        .route("/ws", get(websocket_handler))
        .fallback_service(ServeDir::new("static")); // Or embedded
    
    // 6. Bind to random localhost port (or config)
    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();
    
    // 7. Open browser automatically
    let url = format!("http://localhost:{}", actual_port);
    println!("Starting ncpure at {}", url);
    webbrowser::open(&url)?;
    
    // 8. Start server with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    
    Ok(())
}
```

## Build & Deployment

```bash
# Development
cargo run
# Serves on random port, opens browser, auto-reloads not included

# Production build
cargo build --release
# Single binary: ./target/release/ncpure-web
# ~5-10MB depending on feature flags

# Installation
cargo install --path .
# Binary available as `ncpure-web` or just `ncpure`

# Data migration from PureRef (future)
ncpure import --from-pureref ~/my-board.pur
```

## Integration Points

### With TUI Client
- TUI connects via WebSocket to `ws://localhost:<port>/ws`
- Same JSON messages, renders with ncurses instead of Canvas
- Can run simultaneously: web on main monitor, TUI in tmux on laptop

### With AI Bridge
- Configurable endpoint in `config.toml`: `ai_bridge_url = "http://localhost:5000"`
- `POST /api/search?q=query` forwards to AI bridge if configured
- Bridge returns candidates, daemon downloads to `~/ncpure/staging/`
- WebSocket notifies clients: `{ type: 'ai_candidate', payload: {...} }`
- User approves/rejects candidates in UI (keep or discard)

### With External Tools
- **Blender**: Addon that connects to daemon, shows references in 3D viewport
- **Photoshop/Krita**: Panel that embeds web view
- **File manager**: Drag-drop images onto browser window (HTML5 drop API)

## Future Features

- **Multiple boards**: Tab interface for switching contexts
- **Annotations**: Draw on canvas (arrows, text notes, circles)
- **Export**: PNG/PDF of entire board or selection
- **Collaboration**: Sync multiple users via WebRTC or central server
- **Plugins**: WASM-based extensions for custom importers/exporters
- **Mobile app**: React Native wrapper around same API

## Similar Projects / Inspiration

- **PureRef**: The gold standard (proprietary)
- **Milanote**: Web-based, subscription, more structured than canvas
- **Are.na**: Social bookmarking with image focus
- **VSCO/Adobe Bridge**: More catalog-oriented than canvas
- **OBS Studio**: Similar client-daemon model (OBS Studio + OBS WebSocket)

## License

MIT or GPL-3.0 (to be decided)
