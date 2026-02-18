---
id: mt-hgrp
status: closed
deps: [mt-it7x]
links: []
created: 2026-02-18T00:26:33Z
type: task
priority: 2
assignee: kmd
parent: mt-7sbq
tags: [backend, tools]
---
# Tool registry with Zod→OpenAI conversion

Implement src/tools/registry.ts: registerTool<T>(name, description, schema: ZodObject, handler, category) function. zodToOpenAI() converter that walks Zod schema and produces OpenAI function parameters format. getTools(codingMode) returns filtered tool list. executeTool(name, rawArgs, ctx) with argument deserialization per SHARP_EDGES.md: try JSON.parse if string, handle Codex '*** Begin Patch' format, return helpful errors on validation failure (never opaque errors).

