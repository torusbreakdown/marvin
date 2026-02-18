---
id: cat-3n5i
status: open
deps: []
links: []
created: 2026-02-18T09:41:30Z
type: bug
priority: 2
assignee: kmd
tags: [security]
---
# Fix command injection risk in downloads.ts

downloads.ts uses template strings with execSync (e.g. execSync(`curl ${url}`)) which allows command injection via crafted URLs. Replace with execFileSync or array-based spawn to prevent shell interpretation of user-supplied arguments.

## Acceptance Criteria

All subprocess calls in downloads.ts use execFileSync or spawn with argument arrays; no shell interpolation of user input

