---
id: mt-dwtc
status: closed
deps: [mt-33kf]
links: []
created: 2026-02-18T00:25:25Z
type: epic
priority: 0
assignee: kmd
tags: [backend, llm]
---
# Epic: LLM Provider System

Implement the LLM provider layer: Provider interface, OpenAI-compatible chat (streaming + non-streaming), Copilot SDK integration (single listener per session, timeout→destroy+rebuild), Ollama provider, provider routing in router.ts. This is the core engine — tools and UI both depend on it.

