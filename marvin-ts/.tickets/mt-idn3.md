---
id: mt-idn3
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
# Provider interface and OpenAI-compat client

Implement src/llm/openai.ts: Provider interface with chat() method, OpenAI-compatible HTTP client using undici/fetch. Support both streaming (SSE parsing, delta extraction) and non-streaming modes. Handle Gemini thinking config, streaming backpressure, usage extraction from response. 300s timeout with 10s connect timeout. Return {message, usage} tuple.

