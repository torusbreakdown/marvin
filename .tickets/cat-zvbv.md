---
id: cat-zvbv
status: open
deps: [cat-3n5i]
links: []
created: 2026-02-18T09:41:13Z
type: task
priority: 2
assignee: kmd
tags: [testing]
---
# Add downloads.ts and packages.ts tests

downloads.ts (2 tools: download_file, download_video) and packages.ts (1 tool: install_packages) wrap subprocess calls (curl, yt-dlp, npm, pip, apt) with zero tests. Need mocked subprocess tests for: successful downloads, missing tool errors, invalid URLs, package install success/failure.

## Acceptance Criteria

Both files have tests with mocked subprocess execution; error cases for missing tools and invalid inputs covered

