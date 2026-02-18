---
id: mt-yn4q
status: closed
deps: [mt-it7x]
links: []
created: 2026-02-18T00:26:01Z
type: task
priority: 2
assignee: kmd
parent: mt-dwtc
tags: [backend, llm]
---
# Copilot SDK provider

Implement src/llm/copilot.ts: CopilotProvider wrapping the Copilot SDK. Register event listener ONCE at session creation (not per request). On timeout: destroy session, null it out, next request creates fresh session. Session timeout: 180s normal, 900s coding mode. Handle message_delta, assistant.message, session.idle events. Emit through StreamCallbacks.

