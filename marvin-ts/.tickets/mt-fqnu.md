---
id: mt-fqnu
status: open
deps: [mt-hkme]
links: []
created: 2026-02-18T00:27:25Z
type: task
priority: 2
assignee: kmd
parent: mt-i4hu
tags: [frontend, ui]
---
# TUI streaming, input, and keyboard shortcuts

Implement streaming display in curses.ts: thinking indicator ('⟳ Thinking...') when waiting for first token, partial response with animated dots ('⟳ Assistant...'), character-by-character streaming. Input: full readline editing (left/right/home/end/backspace/Ctrl+W), up/down for input history, Enter submits, buffer keystrokes while busy. Keyboard shortcuts: PgUp/PgDn (10 lines), Shift+arrows (1 line), mouse wheel, Ctrl+Q/Ctrl+D quit.

