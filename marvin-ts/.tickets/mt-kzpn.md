---
id: mt-kzpn
status: closed
deps: [mt-hgrp]
links: []
created: 2026-02-18T00:26:33Z
type: task
priority: 2
assignee: kmd
parent: mt-7sbq
tags: [backend, tools]
---
# Core coding tools: files, shell, git

Implement src/tools/files.ts (read_file with 10KB guard, create_file, append_file, apply_patch with old_str/new_str, list_files, grep_files, find_files — all with path sandboxing: reject absolute paths, reject .., include working dir + tree in errors), src/tools/shell.ts (run_command with timeout, confirmation via ctx.confirmCommand), src/tools/git.ts (git_status, git_diff, git_log, git_blame, git_commit, git_branch, git_checkout — unset GIT_DIR before all operations).

