---
id: cat-gycz
status: open
deps: []
links: []
created: 2026-02-18T09:41:48Z
type: task
priority: 3
assignee: kmd
tags: [testing]
---
# Improve music.test.ts coverage

music.test.ts has the lowest quality rating among existing tests — happy paths only, no error handling tests. Add tests for: API failures, malformed responses, network timeouts, empty results.

## Acceptance Criteria

music.test.ts includes error path tests with mocked fetch failures and malformed API responses

