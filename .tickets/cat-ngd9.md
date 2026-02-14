---
id: cat-ngd9
status: in_progress
deps: []
links: []
created: 2026-02-14T21:46:10Z
type: epic
priority: 1
assignee: kmd
tags: [greenfield, fastapi, sse, sqlite, frontend, tdd, design-first]
---
# Greenfield: Marvin web interface (FastAPI + SSE + SQLite + static frontend)

Build a complete web interface for Marvin per spec.

Core features:
1) Chat UI: full-screen chat, message history (user right/Marvin left), SSE streaming, markdown rendering with syntax-highlighted code blocks + copy button, auto-scroll with user-scroll pause, multiline textarea (expand to 6 lines; Enter sends; Shift+Enter newline), typing indicator, timestamps on hover.
2) Conversation management: sidebar with past conversations (auto-title from first message), new/delete conversation, SQLite persistence, search by content.
3) Status bar: top bar with model name, connection status dot, token count if available, collapses to icons on mobile.
4) Settings panel: theme toggle (default dark), model dropdown, per-conversation system prompt textarea, export conversation as Markdown.
5) Backend API: POST /api/chat (SSE stream), GET/POST /api/conversations, GET/DELETE /api/conversations/{id}, GET /api/status, PATCH /api/conversations/{id}/settings.
6) Error handling: inline retry on network error, system-styled error messages in chat, SSE reconnect with exponential backoff, cached conversation display when backend is down.

Non-functional:
- FCP < 500ms
- Keyboard accessible with ARIA
- Works in Firefox + Chromium
- No CDN deps
- Syntax highlighting < 50KB inline

Required file structure:
- main.py, database.py, bridge.py
- static/index.html, static/styles.css, static/app.js, static/chat.js, static/sidebar.js, static/settings.js
- tests/test_api.py, tests/test_database.py, tests/test_bridge.py
- pyproject.toml, README.md

Use design_first=true and tdd=true. Keep changes minimal and self-contained.


## Notes

**2026-02-14T21:46:34Z**

Phase 1: Design pass (claude-opus-4.5)

**2026-02-14T21:46:36Z**

Design pass failed (exit 1)

**2026-02-14T21:46:44Z**

Phase 1: Design pass (claude-opus-4.5)

**2026-02-14T21:46:46Z**

Design pass failed (exit 1)
