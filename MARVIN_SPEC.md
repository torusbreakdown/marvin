# Marvin Behavioral Specification

> **Purpose**: This document specifies how Marvin behaves as an agent system —
> operating modes, pipeline phases, sub-agent contracts, tool gating, and
> invariants. It is the behavioral complement to
> [MARVIN_API_SPEC.md](./MARVIN_API_SPEC.md) (integration/IO contracts) and
> [TOOLS.md](./TOOLS.md) (tool schemas).
>
> **Audience**: Developers reimplementing Marvin, particularly the coding
> pipeline and sub-agent orchestration.

---

## 1. Overview

Marvin is a CLI assistant with ~90 tools spanning location, web search, coding,
notes, calendar, media, and more. It runs in two primary modes: **interactive**
(terminal UI) and **non-interactive** (pipeline/coding mode). This document
specifies the behavioral contracts for both modes, with emphasis on the coding
pipeline.

Key architectural facts:
- Single-process CLI (`app.py`), no cloud deployment
- Multiple LLM backends (Copilot SDK, Gemini, Groq, Ollama, OpenAI-compatible)
- Stateful in interactive mode (preferences, history, saved places)
- Stateless per-invocation in non-interactive mode (context passed via flags)
- Sub-agents are child processes of the same binary, gated by tickets and env vars

---

## 2. Operating Modes

### 2.1 Interactive Mode

Default mode when launched without flags.

- Curses-based TUI (or `--plain` for readline) with colored chat, scrolling,
  status bar, and input history
- User types messages, Marvin responds with tool calls and text
- All ~90 tools available
- Conversation history persisted to `chat_log.json` and seeded into the LLM
  as user/assistant messages (last 20 entries)
- Slash commands available (`!shell`, `!code`, `!voice`, etc.)
- Coding mode toggleable via `!code`

### 2.2 Non-Interactive Mode (`--non-interactive`)

Launched with the `--non-interactive` flag.

- Reads prompt from `--prompt` flag or stdin
- Streams response tokens to stdout (raw text, not structured)
- Emits cost data to stderr as `MARVIN_COST:{json}` on exit
- Used by parent processes (web UI bridges, CI, other agents) to integrate
  Marvin as a subprocess
- Does NOT load conversation history into the LLM message array (only compact
  history in the system message — last 20 entries truncated to 200 chars each)
- Does NOT persist conversation to disk
- Always runs with coding mode enabled (`_coding_mode = True`)
- Auto-approves all tool calls (no user confirmation)
- Tool loop runs up to 50 rounds

### 2.3 Coding/Pipeline Mode (`--non-interactive --working-dir PATH`)

Activated when both `--non-interactive` and `--working-dir` are set.

- All file operations sandboxed to the working directory
- Loads `.marvin/spec.md` and `.marvin/design.md` if present
- Loads `.marvin-instructions` or `.marvin/instructions.md` for project rules
- When `--design-first` is also set, enters the full TDD pipeline
  (spec → design → test → implement → debug → QA)
- Sub-agents are spawned as child processes of the same binary
- Each sub-agent gets a subset of tools (coding tools only)
- The working directory is a git repo (initialized by the pipeline if needed)

---

## 3. The TDD Pipeline

### 3.1 Phase Order

```
Phase       Description                                      Parallelism
─────       ───────────                                      ───────────
1a          Product Spec + UX Design                         Sequential agents
1a_review   Spec conformance review + fix loop               Sequential
1b          Architecture + Test Plan                         Sequential
1b_review   Design review + fix loop                         Sequential
2a          Functional test writing (TDD red phase)          Sequential
2b          Integration/E2E test writing                     Sequential
3           Implementation (make tests pass)                 Sequential
4a          Debug loop (run tests until green)               Sequential
4b          E2E smoke test                                   Sequential
5           Adversarial QA (security, performance, edges)    Sequential
```

Phase 1a runs two agents in parallel: one writes `spec.md`, the other writes
`ux.md`. All subsequent phases are sequential — parallel execution is only
safe for readonly reviewers.

### 3.2 State Persistence

- State stored in `.marvin/pipeline_state` as plain text (e.g., `"2a"`)
- On resume, phases already completed are skipped
- **Anti-downgrade invariant**: `save_state(phase)` MUST be a no-op if
  the current persisted state is later than `phase`. This prevents completed
  work from being redone after a crash when `save_state` is called
  unconditionally (including from skipped phases).
- `phase_done(phase)` reads from disk every call — NEVER cached in memory.
  The in-memory value goes stale as `save_state` writes update the file.

### 3.3 Document Generation (Phases 1a, 1b)

Agents write `spec.md`, `ux.md`, `design.md` to `.marvin/`.

**Retry loop**: After the agent finishes, check that the output file:
1. Exists on disk
2. Is ≥1000 bytes

If either check fails, delete any garbage file and retry (max 3 attempts).
Abort the pipeline if all retries are exhausted.

**Tool requirements**:
- Agents MUST use the `create_file` tool explicitly — no stdout-to-file
  fallback. Agents sometimes dump chain-of-thought planning text to stdout;
  capturing this and writing it to a file produces garbage that passes size
  checks but contains planning notes instead of real content.
- Large documents: write the first 2000–4000 words with `create_file`, then
  continue with `append_file`. This avoids streaming timeouts — the LLM
  streams tool call arguments token-by-token, and arguments >15KB can take
  10+ minutes or time out entirely.

### 3.4 Review/Fix Loops

After each document phase (1a, 1b), a review cycle runs:

1. **Spec conformance reviewer** (readonly, opus-tier model) checks the
   generated documents against the original requirements
2. Findings are compiled into a fix prompt
3. **Fixer agent** (codex-tier model) applies the fixes
4. Re-review if not exhausted (max 4 rounds)

**TDD awareness**: During test-writing phases (2a, 2b), the reviewer will see
tests that import modules that don't exist yet. This is DESIRED behavior in
TDD — the tests define the interface before the implementation. Missing
implementations are NOT findings during test phases. The reviewer must be told
this explicitly.

### 3.5 Model Tiers

```
Tier          Model (default)           Used for
────          ───────────────           ────────
codex         gpt-5.3-codex             Implementation, review fixes
opus          claude-opus-4.6           Code reviews, adversarial QA, plan review
plan          gpt-5.2                   Debug loops, QA fixes
plan_gen      gemini-3-pro-preview      Spec, UX, architecture generation
test_writer   gemini-3-pro-preview      TDD test writing (unit + integration)
aux_reviewer  gpt-5.2                   Additional parallel spec reviewers
```

Overridable via environment variables:
- `MARVIN_CODE_MODEL_LOW` → codex tier
- `MARVIN_CODE_MODEL_HIGH` → opus tier
- `MARVIN_CODE_MODEL_PLAN` → plan tier
- `MARVIN_CODE_MODEL_PLAN_GEN` → plan_gen tier
- `MARVIN_CODE_MODEL_TEST_WRITER` → test_writer tier
- `MARVIN_CODE_MODEL_AUX_REVIEWER` → aux_reviewer tier

### 3.6 Iteration Limits

| Loop            | Env var                | Default |
|-----------------|------------------------|---------|
| Debug (4a)      | `MARVIN_DEBUG_ROUNDS`  | 50      |
| E2E (4b)        | `MARVIN_E2E_ROUNDS`    | 10      |
| QA fix (5)      | `MARVIN_QA_ROUNDS`     | 3       |

---

## 4. Sub-Agent Contracts

### 4.1 Environment Variables

Every sub-agent receives these env vars from the parent:

| Variable              | Description                                                |
|-----------------------|------------------------------------------------------------|
| `MARVIN_DEPTH`        | Nesting depth (incremented from parent). Prevents infinite recursion. |
| `MARVIN_MODEL`        | Which LLM model this agent should use.                     |
| `MARVIN_TICKET`       | Parent ticket ID. Agent MUST create a child ticket before writing files. |
| `MARVIN_READONLY`     | `"1"` for review-only agents. Write tools are blocked.     |
| `MARVIN_SUBAGENT_LOG` | Path to JSONL file for tool call auditing.                 |

### 4.2 Ticket Gating

Sub-agents cannot call any write tool (`create_file`, `append_file`,
`apply_patch`, `run_command`, `git_commit`) until they create a ticket via
`tk create`.

**First-rejection rule**: The FIRST `tk create` call is intentionally rejected.
This forces the agent to write a thorough description with acceptance criteria
on the retry. If the first rejection is skipped, agents write vague one-liner
tickets.

**Exemptions**:
- Readonly agents (`MARVIN_READONLY=1`) are exempt from ticket gating
- The ticket must be a child of the parent ticket (via `--parent` flag)

### 4.3 Tool Call Logging

When `MARVIN_SUBAGENT_LOG` is set, every tool call is logged to the specified
JSONL file. Each entry contains:

```json
{
  "ts": "2025-02-15T12:34:56Z",
  "tool": "create_file",
  "args": "path=src/main.ts, content=import { App...",
  "result": "Created src/main.ts (2847 bytes)",
  "elapsed_ms": 42
}
```

- Arguments are truncated to 200 characters
- Results are truncated to 400 characters
- The parent pipeline uses these logs for observability and debugging

### 4.4 Path Sandboxing

All file operations in coding mode enforce strict path boundaries:

1. **Absolute paths rejected** — all paths must be relative to the working
   directory. Error message includes the working directory AND a project tree
   listing so the agent can orient itself.
2. **Path traversal (`..`) rejected** — cannot escape the working directory.
3. **`.tickets/` directory blocked** — must use the `tk` tool instead.

### 4.5 File Read Guard

If an agent tries to `read_file` on a file larger than 10KB without specifying
`start_line`/`end_line`, the read is rejected with:
- The total line count of the file
- Examples of how to use line ranges

This prevents large files from filling the context window and degrading LLM
performance.

### 4.6 File Locking

Sub-agents in the pipeline run serially for write tasks. File locking was
implemented but caused deadlocks and race conditions. Current policy: no
locking, sequential execution for writers, parallel execution only for
readonly reviewers.

---

## 5. No-Mock Policy

All tests MUST use real implementations, not mocks. This policy is enforced in
every sub-agent prompt via `_project_context()`.

**Prohibited**:
- `unittest.mock`, `monkeypatch`, `MagicMock` (Python)
- `jest.mock()`, `sinon.stub()`, or equivalent (JavaScript/TypeScript)
- Any test double that replaces real behavior with fake behavior

**Required alternatives**:
- In-memory SQLite for database tests
- `httpx.AsyncClient` (Python) or supertest (Node) for API tests
- Real file I/O against temp directories
- Integration tests talk to real (local) services

**Rationale**: Mocks hide bugs. Tests with mocks prove the mock works, not the
code. Real implementations catch integration failures, schema mismatches, and
behavioral regressions that mocks silently pass.

---

## 6. Upstream Reference Documents

Sub-agents get context from `.marvin/upstream/`:

| File                | Description                                     |
|---------------------|-------------------------------------------------|
| `MARVIN_API_SPEC.md`| Integration/IO contracts for bridges and UIs     |
| `MARVIN_SPEC.md`    | This document — behavioral specification         |
| `TOOLS.md`          | Complete tool schema reference (~90 tools)       |
| `SHARP_EDGES.md`    | Implementation gotchas and hard-learned lessons   |
| `README.md`         | Project-level README                              |
| `REFERENCE.md`      | Quick-reference cheat sheet                       |
| `WEB_SPEC.md`       | Web UI product specification (if applicable)      |
| `WEB_DESIGN.md`     | Web UI architecture/design (if applicable)        |

These are **read-only** — agents cannot modify upstream docs. The pipeline
copies them at init from the parent project. Agents access them via
`read_file` with paths like `.marvin/upstream/README.md`.

---

## 7. Git Workflow

- The working directory is a git repo, initialized by the pipeline if needed
- Sub-agents commit after completing their task using the `git_commit` tool
- Commits include the agent's ticket ID in the message
- **`GIT_DIR` contamination**: When Marvin spawns sub-agents, the parent
  process may have `GIT_DIR` set in the environment. If the sub-agent inherits
  this, ALL git commands operate on the wrong repository. Before any git
  operation in a sub-agent, either unset `GIT_DIR` or explicitly validate that
  `.git` exists in the working directory.

---

## 8. Notes System

The `write_note` tool has mode-dependent behavior:

| Mode     | Notes directory            | Rationale                                |
|----------|----------------------------|------------------------------------------|
| Interactive | `~/Notes/`              | User's personal knowledge base           |
| Coding   | `.marvin/notes/` (in project) | Prevents agents from caching impl details across runs |

If agents in coding mode write to `~/Notes/`, they can "cheat" by persisting
implementation knowledge across pipeline runs, defeating the purpose of
isolated agent execution.

---

## 9. CLI Flags

```
Flag                    Description
────                    ───────────
--non-interactive       Enter non-interactive mode (required for pipeline)
--working-dir PATH      Set working directory for coding operations
--design-first          Trigger full TDD pipeline instead of single-shot chat
--model TIER=MODEL      Override model tiers (e.g., --model high=claude-opus-4.6)
--prompt TEXT           Initial prompt text (or read from stdin)
--ntfy TOPIC            ntfy.sh topic for progress notifications
--provider NAME         LLM provider: copilot, gemini, groq, ollama, openai
--plain                 Use readline-based plain text UI (interactive only)
--curses                Use curses TUI (interactive default)
-B                      Disable Python bytecode caching
```

---

## 10. Error Handling Contracts

### 10.1 Tool Call Argument Deserialization

LLMs sometimes send tool call arguments as a JSON **string** instead of a
parsed object. Additionally, some models (especially OpenAI Codex variants)
send unified-diff format as the entire arguments value.

**Requirements**:
- If `arguments` is a string, try `JSON.parse()` first
- If parse succeeds and result is an object, use it
- If parse fails, return a **helpful** error message explaining the expected
  format — never return opaque errors like `"Invoking this tool produced an
  error."` The LLM cannot recover from opaque errors.

### 10.2 Validation Errors

Every parameter validation failure MUST return an actionable error message to
the LLM, including:
- What went wrong (missing field, wrong type, etc.)
- The correct usage with examples

### 10.3 Model-Specific Quirks

- **Gemini**: Tool call responses may arrive in a different format than
  OpenAI/Anthropic. Test tool calling with all providers.
- **OpenAI Codex models**: Tend to send tool args as strings. Also sometimes
  use diff-format for `apply_patch` instead of the 3-param schema.
- **Claude Opus**: Expensive but high quality. Reserve for code reviews and
  adversarial QA, not bulk implementation.
- **Cost tracking**: Each provider has different token pricing. Track
  per-provider to catch runaway costs.

---

## 11. System Context Injection

Every prompt — interactive or non-interactive — receives this context
automatically in the system message:

1. **Personality & rules**: "You are Marvin, a helpful local-business and
   general-purpose assistant..."
2. **User preferences**: Dietary, spice, cuisines, budget from YAML
3. **Active profile name**: e.g., "Active profile: main"
4. **Saved places**: All bookmarked locations with labels, addresses, and
   coordinates — so the LLM can resolve references like "near home"
5. **Compact conversation history**: Last 20 chat log entries (truncated to
   200 chars each)
6. **Coding mode instructions** (when coding): Working directory path, tool
   rules, auto-notes behavior
7. **Project instructions** (when working-dir has `.marvin-instructions`,
   `.marvin/instructions.md`, or `~/.marvin/instructions/<path>.md`)
8. **Spec & design docs** (when working-dir has `.marvin/spec.md` or
   `.marvin/design.md`): Full product spec and architecture

---

## 12. Invariants & Safety Properties

These properties MUST hold at all times:

1. **State never downgrades** — `save_state(phase)` is a no-op if the
   persisted state is later than `phase`
2. **Phase reads are never cached** — `phase_done()` always reads from disk
3. **Agents cannot write without a ticket** — write tools are gated on
   `tk create` (except readonly agents)
4. **Paths cannot escape the sandbox** — absolute paths and `..` are rejected
5. **No stdout-to-file fallback** — agents must use `create_file` explicitly
6. **No mocks in tests** — all tests use real implementations
7. **Sub-agent depth is bounded** — `MARVIN_DEPTH` is incremented on each
   spawn; implementations should enforce a max depth
8. **`GIT_DIR` is unset in sub-agents** — prevents operating on wrong repo
9. **Large file reads are bounded** — files >10KB require line ranges
10. **Tool errors are actionable** — never return opaque error messages
