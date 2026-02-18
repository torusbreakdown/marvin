---
id: mt-96ml
status: open
deps: [mt-yi7w, mt-dwtc, mt-7sbq]
links: []
created: 2026-02-18T00:25:25Z
type: epic
priority: 1
assignee: kmd
tags: [frontend, ui]
---
# Epic: Interactive UI — Plain Mode

Implement ui/plain.ts: readline-based plain terminal UI. Line-in/line-out, streaming tokens printed inline, tool calls shown as '🔧 tool1, tool2', input history support, quit/exit/Ctrl+D handling. Implements the UI interface from types.ts. This is simpler than curses and validates the session/tool loop first.

