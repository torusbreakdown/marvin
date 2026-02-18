---
id: mt-lx7c
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
# Ollama provider

Implement src/llm/ollama.ts: Ollama provider for local models. Check if Ollama is running, auto-pull models if needed. Use OpenAI-compat endpoint (localhost:11434/v1/chat/completions). Strip reasoning_content fields from messages.

