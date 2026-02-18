---
id: cat-fuwa
status: open
deps: []
links: []
created: 2026-02-18T09:40:45Z
type: task
priority: 1
assignee: kmd
tags: [testing]
---
# Add bookmarks.ts tests

bookmarks.ts has 3 real tool implementations (add_bookmark, search_bookmarks, list_bookmarks) using file-based storage with zero tests. Need: CRUD lifecycle tests with temp dirs, search by tags, file corruption/missing file handling.

## Acceptance Criteria

All 3 tools tested with file I/O isolation via temp dirs; search and tag filtering verified; error handling for missing/corrupt files

