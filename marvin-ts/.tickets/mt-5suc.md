---
id: mt-5suc
status: closed
deps: [mt-hgrp]
links: []
created: 2026-02-18T07:03:00Z
type: task
priority: 1
assignee: kmd
parent: mt-7sbq
tags: [backend, llm, provider]
---
# llama-server provider and model/backend switching

Add llama-server (llama.cpp) as a first-class LLM provider. llama-server exposes an OpenAI-compatible API, so it can use OpenAICompatProvider under the hood. Default endpoint: http://localhost:8080/v1.

Additionally, implement a `!model` interactive slash command that lets the user switch provider/model at runtime without restarting the REPL. The command should:
- `!model` with no args — show current provider and model
- `!model <provider>` — switch to provider with its default model
- `!model <provider> <model>` — switch to specific provider and model

Changes required:
1. types.ts: Add 'llama-server' to ProviderConfig.provider union
2. main.ts resolveProviderConfig: Add llama-server defaults (model: 'default', baseUrl: 'http://localhost:8080/v1')
3. main.ts createProvider: Route llama-server to OpenAICompatProvider
4. main.ts help text: Add llama-server to provider list
5. main.ts handleSlashCommand: Add !model command
6. session.ts: Add switchProvider() method to swap provider at runtime
