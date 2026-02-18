---
id: cat-48n7
status: open
deps: []
links: []
created: 2026-02-18T09:40:30Z
type: task
priority: 1
assignee: kmd
tags: [testing]
---
# Add utilities.ts tests

utilities.ts has 6 real tool implementations (convert_units, dictionary_lookup, translate_text, read_rss, system_info, calculate) with zero tests. Highest untested tool count. Need: unit conversion math tests, mocked API tests for dictionary/translation, RSS/Atom parsing tests.

## Acceptance Criteria

All 6 tools have tests covering happy paths and error cases; API calls mocked; conversion math verified

