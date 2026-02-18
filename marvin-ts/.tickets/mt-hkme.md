---
id: mt-hkme
status: open
deps: [mt-it7x]
links: []
created: 2026-02-18T00:27:25Z
type: task
priority: 2
assignee: kmd
parent: mt-i4hu
tags: [frontend, ui]
---
# Blessed TUI layout and rendering

Implement src/ui/curses.ts using blessed: status bar (top, provider/profile/messages/usage), scrollable chat box (middle, colored by role per ux.md §2.3: cyan=you, green=assistant, yellow=system), input box (bottom, '> ' prefix). Render splash from assets/splash.txt on start. Auto-scroll to bottom on new messages, stop if user scrolled up.

