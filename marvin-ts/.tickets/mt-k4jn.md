---
id: mt-k4jn
status: closed
deps: [mt-it7x]
links: []
created: 2026-02-18T00:26:56Z
type: task
priority: 2
assignee: kmd
parent: mt-yi7w
tags: [backend, session]
---
# System prompt builder

Implement src/system-prompt.ts: buildSystemMessage(profile, state) returns the full system prompt string. Includes: personality/rules ('You are Marvin...'), user preferences from YAML, active profile name, saved places with coordinates, compact conversation history (last 20 entries, 200 chars each), coding mode instructions when active, background job status, .marvin-instructions if present, .marvin/spec.md and .marvin/design.md if present in working dir.

