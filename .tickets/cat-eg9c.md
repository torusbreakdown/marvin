---
id: cat-eg9c
status: in_progress
deps: []
links: []
created: 2026-02-14T22:32:55Z
type: epic
priority: 1
assignee: kmd
tags: [greenfield, fastapi, frontend, sse, sqlite, pytest]
---
# Greenfield marvin-web UI + API

Build complete FastAPI + vanilla JS web UI for Marvin with SSE streaming chat, SQLite conversation persistence, sidebar/search, settings (theme/model/system prompt/export), status bar, and pytest suite. Must invoke Marvin via subprocess: `uv run --project /home/kmd/copilot-assistant-thing python /home/kmd/copilot-assistant-thing/app.py --non-interactive --prompt <prompt>` and stream stdout as SSE.


## Notes

**2026-02-14T22:33:02Z**

Phase 1a: Spec & UX design (claude-opus-4.6)
