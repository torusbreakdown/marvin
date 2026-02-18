---
id: cat-mz7j
status: open
deps: []
links: []
created: 2026-02-18T09:41:39Z
type: chore
priority: 3
assignee: kmd
tags: [cleanup]
---
# Clean up dead code and stubs

files-notes.ts is empty (comment only) — remove or implement. blender.ts has 8 stub tools returning 'Not yet implemented' — document timeline or remove from registration. spotify.ts requires OAuth setup — document requirements. Also fix empty catch blocks flagged in code review.

## Acceptance Criteria

Dead files removed or documented; empty catch blocks replaced with proper error handling or logging

