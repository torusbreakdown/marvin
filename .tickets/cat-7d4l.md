---
id: cat-7d4l
status: open
deps: []
links: []
created: 2026-02-18T09:40:20Z
type: task
priority: 0
assignee: kmd
tags: [testing, modes]
---
# Add mode filtering functional tests

The mode system (surf/coding/lockin) has unit tests for state toggling but zero functional tests verifying tool availability filtering. Need tests asserting: surf mode excludes SURF_EXCLUDE tools, coding mode only includes coding-category + CODING_REFERENCE_TOOLS, lockin mode adds LOCKIN_EXTRAS, negative cases (coding tool NOT available in surf).

## Acceptance Criteria

Functional tests for all 3 modes verify correct tool inclusion/exclusion; negative assertions confirm tools don't leak across modes

