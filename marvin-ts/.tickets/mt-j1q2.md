---
id: mt-j1q2
status: closed
deps: [mt-idn3]
links: []
created: 2026-02-18T00:26:01Z
type: task
priority: 2
assignee: kmd
parent: mt-dwtc
tags: [backend, llm]
---
# Router and tool loop

Implement src/llm/router.ts: runToolLoop() — the core tool-calling loop. Provider-agnostic: takes Provider interface + tools schema + messages. Loop: call provider.chat() → if tool_calls, execute in parallel via Promise.all() → append results → loop. Max rounds (10 interactive, 50 coding). On no tool_calls, return final text. Handle context budget checks before each LLM call. Print '🔧 tool1, tool2' for each round. On max rounds, request final streaming completion with tools=null.

