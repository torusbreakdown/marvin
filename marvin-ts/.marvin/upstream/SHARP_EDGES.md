# Sharp Edges — Implementation Gotchas for Marvin

> **Audience**: Developers reimplementing Marvin from scratch in Node.js.
> These are hard-learned lessons from the Python implementation.

---

## 1. Tool Call Argument Deserialization

LLMs sometimes send tool call arguments as a JSON **string** instead of a parsed JSON object. For example, instead of `{"path": "foo.py", "old_str": "..."}` (dict), the LLM sends `'{"path": "foo.py", "old_str": "..."}'` (string).

Additionally, some models (especially OpenAI Codex variants) will try to use unified-diff format (`*** Begin Patch\n*** Update File...`) as the entire arguments value, bypassing the structured parameter schema entirely.

**You MUST**:
- Check if `arguments` is a string; if so, try `JSON.parse()` first
- If parse succeeds and result is an object, use it
- If parse fails (non-JSON string like diff format), return a **helpful** error message explaining the expected format. Do NOT return an opaque error like `"Invoking this tool produced an error. Detailed information is not available."` — the LLM cannot recover from opaque errors.

---

## 2. Pydantic/Validation Errors Must Be Transparent

When a tool parameter validation fails (missing required field, wrong type, etc.), the error message MUST be returned to the LLM with actionable guidance. The Python implementation initially used Pydantic's error handler which returned opaque errors — the LLM would then loop or give up.

**Rule**: Every validation failure should tell the LLM exactly what went wrong and show the correct usage.

---

## 3. Large File Streaming Timeout

The LLM streams tool call arguments token-by-token. When a tool call argument is very large (>15KB of content, like writing an entire file), the streaming can take 10+ minutes or time out entirely.

**Solution**: The `append_file` tool exists specifically for this. Agents are instructed to write large files in sections: `create_file` for the first 2000–4000 words, then `append_file` for remaining sections. Your implementation must support both tools.

---

## 4. File Read Guard (10KB limit)

If an agent tries to `read_file` on a large file (>10KB) without specifying `start_line`/`end_line`, return an error with:
- The total line count of the file
- Examples of how to use line ranges
- DO NOT read the whole file — it fills the context window and degrades LLM performance

---

## 5. Path Security: Absolute Paths and Escaping

Sub-agents WILL try to use absolute paths (e.g., `/home/kmd/project/file.py` instead of `file.py`). They will also try `../` to escape the working directory. Your implementation must:
- Reject absolute paths with a clear error
- Reject `..` path traversal
- Include the working directory path in the error
- Include a directory tree listing so the agent can orient itself

---

## 6. GIT_DIR Environment Variable Contamination

When Marvin spawns sub-agents, the parent process may have `GIT_DIR` set in the environment. If the sub-agent inherits this, ALL git commands will operate on the wrong repository.

**Solution**: Before any git operation in a sub-agent, either:
- Unset `GIT_DIR` from the environment, or
- Explicitly pass `--git-dir=.git` or check that `.git` exists in the working directory

---

## 7. Pipeline State Machine Anti-Downgrade

The pipeline progresses through phases: `1a → 1a_review → 1b → 1b_review → 2a → 2b → 3 → 4a → 4b → 5`. State is persisted to `.marvin/pipeline_state`.

**Critical**: `save_state(phase)` must NEVER downgrade — if the current state is `2a` and you call `save_state("1b")`, it must be a no-op. This happens when phases call `save_state` unconditionally (including when skipped). Without anti-downgrade protection, resuming after a crash can redo completed work.

Also: `phase_done(phase)` must read from disk every time, not cache in memory. The in-memory value goes stale as `save_state` writes to disk.

---

## 8. Ticket Gate — First Rejection Is Intentional

Sub-agents must create a ticket before any file write operations. The FIRST `tk create` call is intentionally rejected — this forces the agent to write a thorough description with acceptance criteria on the retry. If you skip the first rejection, agents write vague one-liner tickets.

Readonly agents (`MARVIN_READONLY=1`) are exempt from ticket gating.

---

## 9. Spec Conformance Reviewer Must Be TDD-Aware

During the test-writing phase (before implementation exists), the spec conformance reviewer will see tests that import modules that don't exist yet. This is DESIRED behavior in TDD — the tests define the interface before the implementation.

If the reviewer complains "module X doesn't exist" during a test-only phase, it's a false positive. The reviewer must be told that missing implementations are expected during test phases.

---

## 10. Retry Loops for Document Generation

Spec, UX, and design agents sometimes fail to create their output files — they write chain-of-thought to stdout instead, or create tiny garbage files. You MUST:
- Check that the output file exists AND is >1000 bytes after the agent finishes
- If not, delete any garbage file and retry (up to 3 times)
- Abort the pipeline if all retries fail

---

## 11. Model-Specific Quirks

- **Gemini**: Tool call responses may come in a different format than OpenAI/Anthropic. Test tool calling with all providers.
- **OpenAI Codex models**: Tend to send tool args as strings (see #1). Also sometimes use diff-format for `apply_patch` instead of the 3-param schema.
- **Claude Opus**: Expensive but high quality. Use for code reviews and adversarial QA, not for bulk implementation.
- **Cost tracking**: Each provider has different token pricing. Track per-provider to catch runaway costs.

---

## 12. Sub-Agent Environment Variables

When spawning sub-agents, these env vars MUST be set:
- `MARVIN_DEPTH`: Incremented from parent. Prevents infinite nesting.
- `MARVIN_MODEL`: The model this agent should use.
- `MARVIN_TICKET`: Parent ticket ID. Agent must create a child ticket before writing files.
- `MARVIN_READONLY`: `"1"` for review-only agents (blocks write tools).
- `MARVIN_SUBAGENT_LOG`: Path to JSONL log file for tool call auditing.

---

## 13. Notes Redirection in Coding Mode

Agents have a `write_note` tool. In coding mode, notes MUST be written to `.marvin/notes/` inside the project directory, NOT to `~/Notes/`. If agents write to `~/Notes/`, they "cheat" by caching implementation details across runs.

---

## 14. stdout-to-File Fallbacks Are Dangerous

Never auto-capture an agent's stdout and write it to a file as a fallback. Agents sometimes dump chain-of-thought planning text to stdout instead of using `create_file`. If you capture this garbage and write it to `spec.md`/`design.md`, you get a file that passes size checks but contains planning notes instead of real content.

**Rule**: Agents must use the `create_file` tool explicitly. No stdout-to-file magic.

---

## 15. File Locking Is Unnecessary (for now)

Sub-agents in the pipeline run serially for write tasks. File locking was implemented but caused deadlocks and race conditions. Current solution: no locking, sequential execution for writers, parallel execution only for readonly reviewers.
