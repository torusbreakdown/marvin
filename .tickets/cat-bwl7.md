---
id: cat-bwl7
status: open
deps: []
links: []
created: 2026-02-18T09:40:08Z
type: task
priority: 0
assignee: kmd
tags: [testing, security]
---
# Add SSRF validation tests

ssrf.ts is security-critical code protecting against server-side request forgery and has zero tests. Add comprehensive tests covering: blocked ranges (loopback, metadata, private IPs, link-local), hex/decimal/octal encoding bypasses, and legitimate URL passthrough.

## Acceptance Criteria

All private/internal IP ranges blocked; encoding bypass attempts caught; legitimate URLs pass; tests added to tests/tools/ or tests/ssrf.test.ts

