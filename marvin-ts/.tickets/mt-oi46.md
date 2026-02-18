---
id: mt-oi46
status: closed
deps: [mt-vuwh, mt-03l5, mt-k4jn]
links: []
created: 2026-02-18T00:26:56Z
type: task
priority: 2
assignee: kmd
parent: mt-yi7w
tags: [backend, session]
---
# SessionManager with busy/done lifecycle

Implement src/session.ts: SessionManager class. Holds SessionState (busy, done Promise, conversation history, provider, streamingChunks). submit(text, callbacks) method: poll ntfy, build system message, dispatch to router, clean up busy/done in finally block (NEVER conditionally). Provider fallback: on error, fall back to Copilot SDK. Conversation history capped at 40 (interactive) / 100 (coding mode).

