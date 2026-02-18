---
id: cat-vonh
status: open
deps: []
links: []
created: 2026-02-18T09:41:22Z
type: task
priority: 2
assignee: kmd
tags: [testing, llm]
---
# Improve Copilot and Ollama provider tests

copilot.test.ts and ollama.test.ts only verify object construction/config parsing — no chat behavior tests. Add HTTP-mocked tests following the openai.test.ts pattern: chat requests, streaming responses, tool call handling, error codes (401/429/5xx), timeout handling.

## Acceptance Criteria

Both provider test files include chat behavior tests with HTTP mocking; error handling and streaming verified

