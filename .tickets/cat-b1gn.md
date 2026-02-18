---
id: cat-b1gn
status: open
deps: []
links: []
created: 2026-02-18T09:41:05Z
type: bug
priority: 2
assignee: kmd
tags: [reliability]
---
# Add error handling to travel.ts

travel.ts (get_directions, geocode) has no try-catch around Nominatim/OSRM API calls. API failures throw unhandled errors that crash the tool loop. Wrap API calls in try-catch and return user-friendly error messages, then add tests with mocked fetch.

## Acceptance Criteria

API failures return descriptive error strings instead of throwing; tests verify error handling with mocked network failures

