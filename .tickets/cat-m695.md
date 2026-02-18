---
id: cat-m695
status: open
deps: []
links: []
created: 2026-02-18T09:40:55Z
type: task
priority: 1
assignee: kmd
tags: [testing, llm]
---
# Add llama-server provider tests

llama-server.ts is the only LLM provider with no test file. It has custom error recovery logic for connection failures and model errors. Follow the openai.test.ts pattern with HTTP mocking for: construction, chat behavior, streaming, tool calls, error recovery, connection failures.

## Acceptance Criteria

llama-server.test.ts exists with HTTP-mocked tests for chat, streaming, tool calls, and error recovery paths

