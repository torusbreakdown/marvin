---
id: mt-ttc9
status: open
deps: [mt-it7x]
links: []
created: 2026-02-18T00:27:25Z
type: task
priority: 2
assignee: kmd
parent: mt-96ml
tags: [frontend, ui]
---
# Plain readline UI

Implement src/ui/plain.ts: PlainUI class implementing UI interface. Uses Node readline for input with history. Streaming: print deltas inline. Tool calls: print '🔧 tool1, tool2'. System messages: dimmed. Welcome message on start. quit/exit/Ctrl+D to exit. No colors beyond basic ANSI. This is the simplest UI path and should be implemented first to validate the session loop.

