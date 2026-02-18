---
id: mt-yi7w
status: closed
deps: [mt-33kf]
links: []
created: 2026-02-18T00:25:25Z
type: epic
priority: 0
assignee: kmd
tags: [backend, session]
---
# Epic: Session & State Management

Implement SessionManager (busy/done lifecycle with finally blocks), context.ts (token budget tracking, compaction at 200K, backup to .marvin/logs/), history.ts (chat_log.json load/save/append), usage.ts (per-provider token counts, costs, lifetime persistence to ~/.config/local-finder/usage.json), system-prompt.ts (build system message with preferences, saved places, coding mode instructions, background jobs).

