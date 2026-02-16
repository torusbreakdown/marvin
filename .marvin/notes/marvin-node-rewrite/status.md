## Status (2026-02-15)

### What’s present in the workspace
- `MARVIN_API_SPEC.md` (801 lines): describes non-interactive mode as **raw stdout token stream** + `MARVIN_COST:{json}` final line on stderr; exit codes 0/1; flags: `--non-interactive`, `--prompt`, `--working-dir`, `--design-first`, `--ntfy`, `--provider`.
- `README.md`, `REFERENCE.md`: Local Finder feature overview + API endpoints + state file locations.

### What’s missing (blocking exact drop-in rewrite)
- `.marvin/upstream/` directory does **not** exist in this workspace.
- `WEB_SPEC.md` and `WEB_DESIGN.md` are not present anywhere under `/home/kmd` (searched up to depth 6).

### Notable spec mismatch to clarify
- User request mentions “stdout JSON protocol for non-interactive mode”, but `MARVIN_API_SPEC.md` explicitly states stdout is **free-form streamed text tokens**, not JSON.

### Next needed inputs
- Provide the complete contents of `.marvin/upstream/` (at least the listed docs) and `WEB_SPEC.md` / `WEB_DESIGN.md`, or point to the correct repo/path containing them.
