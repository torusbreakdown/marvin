---
id: mt-vuwh
status: closed
deps: [mt-it7x]
links: []
created: 2026-02-18T00:26:56Z
type: task
priority: 2
assignee: kmd
parent: mt-yi7w
tags: [backend, session]
---
# Context budget tracking and compaction

Implement src/context.ts: estimateTokens(messages) via JSON.stringify length / 4. Warn at 180K, compact at 200K (keep system + last 8 messages, summarize middle), hard limit at 226K. Save backup to .marvin/logs/context-backup-{ts}.jsonl before compaction. Index backup with keyword extraction to .marvin/memories/INDEX.md. Budget-gate read_file results: truncate if they'd push past warn threshold.

