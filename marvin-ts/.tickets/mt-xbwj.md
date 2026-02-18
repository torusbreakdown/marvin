---
id: mt-xbwj
status: open
deps: [mt-oi46, mt-j1q2]
links: []
created: 2026-02-18T00:27:25Z
type: task
priority: 2
assignee: kmd
parent: mt-j569
tags: [backend, integration]
---
# Non-interactive mode implementation

Implement non-interactive path in main.ts: read prompt from --prompt or stdin, create SessionManager with codingMode=true and nonInteractive=true, auto-approve all shell commands, stream raw tokens to stdout (no ANSI), print tool calls as '🔧 name' lines, emit MARVIN_COST:{json} to stderr on exit, exit 0 success / 1 error. Tool loop runs 50 rounds max.

