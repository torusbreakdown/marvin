---
id: cat-m8px
status: open
deps: [cat-sob1]
links: []
created: 2026-02-16T19:39:16Z
type: epic
priority: 0
assignee: kmd
---
# Marvin Node.js Rewrite — Phase 5: Non-Interactive Mode & Pipeline

Implement the non-interactive mode and design-first TDD pipeline.

Deliverables:
- CLI argument parsing (--non-interactive, --prompt, --working-dir, etc.)
- Stdout streaming format
- Stderr cost data emission (MARVIN_COST:)
- Design-first pipeline phases (1a through 5)
- Sub-agent spawning via launch_agent
- Ticket system integration (tk CLI wrapper)
- Pipeline state persistence

