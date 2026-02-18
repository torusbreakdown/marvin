# Marvin — UX Specification

> **Version**: 1.1 (TypeScript rewrite)

---

## 1. Interaction Model

Marvin is a **conversational CLI**. The user types a message, Marvin calls
tools as needed, and streams a response. There is no command syntax to learn —
just natural language.

Three interaction surfaces:

- **Curses TUI** (default): full-terminal blessed/neo-blessed interface with
  colors, scrolling, status bar, and input history
- **Plain readline** (`--plain`): simple line-in/line-out for terminals that
  can't handle curses, pipes, or accessibility needs
- **Non-interactive** (`--non-interactive`): single-shot subprocess mode with
  raw stdout streaming — no TUI, no user interaction (see §7)

---

## 2. Curses TUI Layout

```
┌────────────────────────────────────────────────────────────┐
│  🤖 claude-haiku-4.5 │ Profile: kevin │ Messages: 42 │ ... │  ← status bar
├────────────────────────────────────────────────────────────┤
│                                                            │
│  14:22 👤 You:                                             │
│    find me a good ramen place nearby                       │
│                                                            │
│  14:22 🤖 Assistant:                                       │
│    🔧 get_my_location, places_text_search                  │
│    Found 3 ramen spots near you...                         │
│                                                            │
│  14:23 ⟳ Thinking...                           ← streaming │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  > _                                           ← input box │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Status Bar

Single line at the top. Always visible, never scrolls.
```
 {provider_emoji} {model} │ Profile: {name} │ Messages: {n} │ {usage_summary} │ {mode_flags}
```

- **Usage summary**: `$0.0023 (12K tok)` or similar
- **Mode flags** (shown when active):
  - `🔧 CODING` — coding mode is on
  - `🐚 SHELL` — shell mode is on
  - `🎤 VOICE` — voice mode is on
- Provider emoji: 🤖 Copilot, 💎 Gemini, ⚡ Groq, 🦙 Ollama, 🔮 OpenAI-compat

### 2.2 Chat Area

- Scrollable, fills all space between status bar and input box
- Each message block: timestamp, role label, text
- Tool calls shown inline as `  🔧 tool1, tool2` before the response text
- Assistant messages stream in character by character
- Thinking indicator while waiting for first token: `  ⟳ Thinking...`
- Partial streaming shown with animated dots: `  ⟳ Assistant...`
- System messages (session start, profile changes, errors) in a distinct color

#### Tool Call Display (Sequential and Parallel)

When the LLM makes tool calls, the user sees them as they happen:

1. **Single tool call**: `  🔧 web_search` appears, followed by a brief
   pause while the tool executes, then the response text streams in.

2. **Multiple sequential tool calls** (tool loop): Each round of tool calls
   gets its own `🔧` line. The user sees:
   ```
   🔧 get_my_location
   🔧 places_text_search, weather_forecast
   Found 3 ramen spots near you. The weather is...
   ```
   Each `🔧` line appears as the tools are dispatched, giving the user
   visibility into what Marvin is doing.

3. **Parallel tool calls** (multiple tools in one LLM response): Shown on a
   single `🔧` line, comma-separated: `🔧 web_search, scrape_page, browse_web`

4. **Long-running tool execution** (e.g., 30-second shell command): The `🔧`
   line remains visible. An elapsed-time indicator updates every few seconds:
   ```
   🔧 run_command (12s...)
   ```
   This reassures the user that Marvin hasn't stalled. After the tool
   completes, streaming resumes normally.

5. **Tool errors**: If a tool fails, the error is shown inline in the
   assistant's response text (not as a separate system message). The LLM
   typically explains the error and may retry.

### 2.3 Colors

| Role       | Color          |
|------------|---------------|
| You        | Cyan           |
| Assistant  | Green          |
| System     | Yellow/dim     |
| Tool names | Magenta/dim    |
| Error      | Red            |
| Status bar | Default/dim    |

### 2.4 Input Box

- Single-line input at bottom, fixed height
- Prefixed with `> `
- Full readline-style editing: left/right, home/end, backspace, Ctrl+W,
  Ctrl+A (home), Ctrl+E (end), Ctrl+U (clear line)
- Up/Down arrow scrolls input history (saved to
  `~/.config/local-finder/profiles/{name}/history`)
- Enter submits
- While `busy=true`, keypresses are buffered and submitted after current
  response finishes
- Input prompt changes contextually:
  - Normal: `> `
  - Shell mode: `$ `
  - Coding mode confirmation: `Run? [Enter/Ctrl+C] > `

### 2.5 Scrolling

- `PgUp` / `PgDn` — scroll chat 10 lines
- `Shift+↑` / `Shift+↓` — scroll 1 line
- Mouse wheel — scroll
- Auto-scroll to bottom on new messages; stops if user has manually scrolled up

---

## 3. Plain Readline Mode

For terminals that don't support curses, piped I/O, screen readers, or when
`--plain` is passed:

```
$ marvin --plain

🤖 Marvin (claude-haiku-4.5) — Profile: kevin
Type your message. Ctrl+D or 'quit' to exit.

You: find me ramen nearby
  🔧 get_my_location, places_text_search
Found 3 great ramen spots near you:
  1. Ippudo — 0.3mi — 4.5⭐  ...

You: _
```

- Streaming tokens printed inline, no animation
- Tool calls printed as `  🔧 tool1, tool2` before response (same format as
  curses mode, ensuring feature parity)
- Long-running tools show `  🔧 tool_name...` with no elapsed timer (plain
  mode avoids cursor repositioning)
- `readline` for input with history support (same history file as curses)
- `quit` / `exit` / Ctrl+D exits
- All slash commands work identically to curses mode
- System messages printed as `[System] message text` on their own line
- Error messages printed as `[Error] message text` in plain text (no color
  codes emitted; if stdout is a TTY, ANSI colors are used; if piped, raw text)
- Shell mode prompt changes to `$ ` (same as curses)
- Voice mode works identically (records audio, transcribes, submits)
- Profile switching shows `[System] Profile switched to: {name}`
- Notifications shown as `[🔔] notification text`

**Feature parity guarantee**: Every interactive feature available in curses
mode MUST also work in plain mode. Plain mode is not a degraded experience —
it is an alternative presentation of the same functionality.

---

## 4. Keyboard Shortcuts (Curses)

| Key            | Action                          |
|----------------|---------------------------------|
| Enter          | Submit message                  |
| ↑/↓            | Scroll input history            |
| PgUp / PgDn    | Scroll chat                     |
| Shift+↑/↓      | Scroll chat 1 line              |
| Ctrl+Q / Ctrl+D| Quit                            |
| Ctrl+C         | Cancel current operation (see §10.5) |
| Ctrl+W         | Delete word in input            |
| Ctrl+A         | Jump to start of input          |
| Ctrl+E         | Jump to end of input            |
| Ctrl+U         | Clear entire input line         |
| Home/End       | Jump to start/end of input      |
| Mouse wheel    | Scroll chat                     |
| Esc            | Quit (alternative)              |

---

## 5. Built-in Commands (Slash Commands)

These are typed in the input box. Commands starting with `!` are mode toggles
or shell escapes. Others are plain keywords. All are handled locally before
sending to the LLM.

### 5.1 Mode Toggles

| Command        | Action                                              |
|----------------|-----------------------------------------------------|
| `!code`        | Toggle coding mode on/off (see §9)                  |
| `!shell` / `!sh` | Toggle shell mode on/off (see §5.3)              |
| `!voice`       | Toggle continuous voice input mode (see §5.4)       |

### 5.2 One-Shot Commands

| Command        | Action                                              |
|----------------|-----------------------------------------------------|
| `!v [N]`       | One-shot voice recording (N seconds, default 5)     |
| `!pro PROMPT`  | Force Copilot SDK for a single query                |
| `!blender`     | Check Blender MCP connection status                 |
| `!COMMAND`     | Execute COMMAND as a shell command (any `!` prefix not matching above) |
| `quit` / `exit`| Exit the app                                        |
| `preferences`  | Open preferences file in `$EDITOR` (default: nano)  |
| `profiles`     | List available profiles                             |
| `usage`        | Show token/cost usage summary                       |
| `saved`        | Show saved places                                   |

### 5.3 Shell Mode (`!shell` / `!sh`)

When shell mode is active:
- The input prompt changes from `> ` to `$ `
- Status bar shows `🐚 SHELL` indicator
- Every line typed is executed as a bash command instead of being sent to the LLM
- Output is displayed in the chat area as a system message
- Type `!shell` or `!sh` again to exit shell mode and return to chat
- Shell mode is useful for quick terminal commands without leaving Marvin

### 5.4 Voice Mode (`!voice`)

When voice mode is active:
- Status bar shows `🎤 VOICE` indicator
- Audio is recorded continuously from the microphone
- Silence detection triggers transcription via Groq Whisper
  (model configurable via `WHISPER_MODEL` env var, default `whisper-large-v3`)
- Transcribed text is automatically submitted as a message
- Type `!voice` again to exit voice mode
- `!v [N]` is the one-shot variant: records for N seconds (default 5),
  transcribes, and submits — then returns to normal input mode

### 5.5 Generic Shell Escape (`!COMMAND`)

Any input starting with `!` that doesn't match a known command is executed as
a shell command. For example:
- `!ls -la` → runs `ls -la` and shows output
- `!git status` → runs `git status` and shows output
- Output appears as a system message in the chat area

---

## 6. Streaming Behavior

### 6.1 Normal Flow

1. User submits message → `busy = true`, `begin_stream()` called, `done` event cleared
2. LLM starts responding:
   - If Copilot SDK: `on_delta` callback streams characters; `on_message` fires when complete; `on_idle` fires when session is ready for next prompt
   - If OpenAI-compat: `_openai_chat` with `stream: true`, deltas piped to `on_delta`
3. Tool calls intercepted mid-stream, executed, results fed back, loop continues
4. Final response: `end_stream()`, message added to chat history
5. `busy = false`, `done` event set — in a `finally` block, always

### 6.2 SDK Session Lifecycle

- Listener registered once at session creation (not per request)
- On timeout: session destroyed and nulled so next request gets a fresh session
- Timeout: 180s normal, 900s coding mode
- Session rebuild is transparent: user sees
  `⚠️ Response timed out after {n}s. Rebuilding session.` as a system message,
  then the prompt is automatically retried

### 6.3 Tool Loop Visibility

During a multi-round tool loop (up to 50 rounds in non-interactive, managed by
SDK in interactive):

```
14:22 👤 You:
  What's the weather and best ramen near me?

14:22 🤖 Assistant:
  🔧 get_my_location                        ← round 1
  🔧 weather_forecast, places_text_search   ← round 2
  The weather in your area is 72°F and sunny. ← final response streams in
  Here are the top ramen spots near you...
```

Each tool round appears as a new `🔧` line immediately when tools are
dispatched. The user can see progress through multiple rounds.

### 6.4 Streaming Interruption

If the user presses **Ctrl+C** during streaming (see §10.5):
- The current LLM response is aborted
- Any partial response already received is kept in the chat area
- `busy` is set to `false`, `done` is set
- The user can immediately type a new message
- A `[Cancelled]` marker appears after the partial response

---

## 7. Non-Interactive Mode UX

Used when called as a subprocess (Copilot CLI sub-agent, CI, web bridges):

```
stdout: raw streamed response tokens (free-form text, not structured)
stderr: MARVIN_COST:{"session_cost":0.0023,"llm_turns":3,"model_turns":{...},"model_cost":{...}}
exit 0: success
exit 1: error (missing --prompt, runtime exception, or LLM failure)
```

- No TUI, no color codes, no readline
- Tool calls logged as `  🔧 tool_name` lines on stdout (detectable by `🔧`
  prefix — integrators can convert these to "thinking" indicators)
- No user confirmation for shell commands (always auto-approved)
- Always runs in coding mode
- Tool loop up to 50 rounds
- Does NOT load full conversation history (only compact history in system
  message — last 20 entries truncated to 200 chars each)
- Does NOT persist conversation to disk
- Does NOT support slash commands
- Reads prompt from `--prompt` flag or stdin
- Strip trailing `\n` from each stdout read to avoid doubled newlines

### 7.1 Stdout Streaming Format

Tokens arrive as fast as the LLM generates them. Each read may contain partial
words, full sentences, or just whitespace. There is no structured framing
(no JSON, no SSE, no length prefixes). The stream ends when the process exits.

### 7.2 Stderr Cost Data

The last meaningful line of stderr contains `MARVIN_COST:` followed by JSON.
Fields: `session_cost` (float, USD), `llm_turns` (int), `model_turns`
(dict of model→count), `model_cost` (dict of model→USD).

---

## 8. Session Start

On launch (interactive):
1. Show ASCII art splash briefly (from `marvin.txt`)
2. Load chat history from `~/.config/local-finder/profiles/{name}/chat_log.json`
   → display as scrollable messages (last 20 entries seeded into LLM context)
3. Show system message: `── Session resumed ──` with profile and provider info
4. If no history: show welcome message with brief usage hints
5. Status bar populated with model name, profile name, message count
6. Input box focused and ready for typing
7. Last active profile auto-restored from `~/.config/local-finder/last_profile`

**History summary on launch**: Recent queries are visible in the chat area,
giving the user context continuity across sessions. The LLM also receives
this history so it can reference prior conversations.

---

## 9. Coding Mode

Activated by `!code` toggle or `--working-dir` flag.

### 9.1 Visual Indicators

- Status bar shows `🔧 CODING` indicator
- System message when toggled: `Coding mode ON 🔧` / `Coding mode OFF`
- Input prompt unchanged (still `> `)

### 9.2 Behavioral Changes

When coding mode is active:
- **Extended timeout**: SDK session timeout increases from 180s to 900s
  (coding tasks take longer)
- **Shell command confirmation**: In interactive mode, `run_command` tool calls
  trigger a confirmation prompt before execution (see §9.3)
- **Working directory context**: The system prompt includes the working
  directory path and project instructions (from `.marvin-instructions`,
  `.marvin/instructions.md`, or `~/.marvin/instructions/<path>.md`)
- **Spec/design loading**: If `.marvin/spec.md` or `.marvin/design.md` exist
  in the working directory, they are loaded into the system prompt
- **Notes redirection**: `write_note` writes to `.marvin/notes/` in the project
  instead of `~/Notes/`
- **File tools available**: `create_file`, `read_file`, `apply_patch`,
  `append_file`, `code_grep`, `tree`, `run_command`, git tools

### 9.3 Shell Command Confirmation Flow

When the LLM calls `run_command` in interactive coding mode, the user sees:

```
🔧 run_command
┌─────────────────────────────────────────┐
│ Run command? [Enter to confirm, Ctrl+C to cancel]  │
│   $ npm test                                       │
└─────────────────────────────────────────┘
```

- **Enter**: Executes the command. Output streams into the chat area.
  Long-running commands show elapsed time: `  ⏱ 12s...`
- **Ctrl+C**: Cancels the command. The LLM is told the user declined and can
  propose an alternative or continue without it.
- The confirmation prompt appears inline in the chat area, not as a modal
- While waiting for confirmation, `busy` remains `true` — the user cannot
  type a new message, only confirm or cancel

**Non-interactive mode**: Shell commands are always auto-approved, no
confirmation prompt.

### 9.4 File Operation Feedback

When the LLM creates or modifies files:
- `create_file`: `  ✅ Created src/main.ts (2847 bytes)`
- `apply_patch`: `  ✅ Patched src/main.ts`
- `append_file`: `  ✅ Appended to src/main.ts (1024 bytes)`
- Errors shown inline: `  ❌ File already exists: src/main.ts`
- Path security violations: `  ❌ Absolute paths not allowed. Working dir: /path/to/project`

---

## 10. Error States and Recovery

### 10.1 Provider Errors

| Error                    | Display                                               |
|--------------------------|-------------------------------------------------------|
| Provider connection error| `⚠️ {provider} error: {msg} — falling back to Copilot SDK` |
| Provider auth error      | `⚠️ {provider} auth failed: {msg}. Check API key.`    |
| SDK timeout              | `⚠️ Response timed out after {n}s. Rebuilding session.` |
| Tool error               | Shown inline in assistant response                     |

**Provider fallback**: When a non-Copilot provider fails (Gemini, Groq, Ollama,
OpenAI-compat), Marvin falls back to the Copilot SDK automatically. The user
sees a yellow system message explaining the fallback. The prompt is retried
with the fallback provider — the user does not need to re-type anything.

### 10.2 Rate Limits

When a provider returns a rate limit error (HTTP 429):
```
⚠️ Rate limited by {provider}. Waiting {n} seconds before retry...
```
The system waits and retries automatically. If the retry also fails:
```
⚠️ Rate limit persists. Try again in a few minutes, or switch provider with --provider.
```
The user regains the input prompt and can type a new message or wait.

### 10.3 Context Limit / Compaction

When the conversation approaches the model's context window limit:
1. **Warning** (at ~80% capacity): Orange system message:
   ```
   ⚠️ Context is 80% full (32K/40K tokens). Consider starting a new session.
   ```
2. **Automatic compaction** (at ~95% capacity): The LLM's `compact_history`
   tool is triggered. The user sees:
   ```
   🔄 Compacting conversation history...
   ── Context compacted. Older messages summarized. ──
   ```
   The chat area is NOT cleared — all messages remain visible for scrolling.
   But the LLM's internal context is reduced (older messages replaced with a
   summary). The user may notice the LLM "forgetting" details from early in
   the conversation.
3. **Manual compaction**: The LLM may decide to call `compact_history` on its
   own when it detects context pressure.

### 10.4 Tool Errors

Tool execution errors are reported inline in the assistant's response, not as
system messages. The LLM typically explains what went wrong and suggests
alternatives. Examples:
- `Web search failed: network timeout. Let me try a different approach...`
- `Could not read file: permission denied.`

### 10.5 Ctrl+C Handling

Ctrl+C has context-dependent behavior:

| State                    | Ctrl+C Action                                    |
|--------------------------|--------------------------------------------------|
| Idle (waiting for input) | No effect (use Ctrl+Q or Ctrl+D to quit)         |
| Streaming response       | Cancel current response, keep partial text        |
| Shell confirmation       | Decline the shell command                         |
| Tool executing           | Cancel current tool, abort response               |
| Voice recording          | Stop recording, discard audio                     |

After any Ctrl+C cancellation, the app returns to the idle input state. The
`busy` flag is always cleared. This is the primary recovery mechanism when the
app appears stalled.

### 10.6 Stall Recovery

If the app appears stuck (no output, no progress):
1. **Ctrl+C** — cancels the current operation and returns to input
2. If Ctrl+C doesn't work (rare, indicates a bug): Ctrl+Q or Ctrl+D to quit
3. On next launch, the session resumes normally from saved history

The `busy` flag and `done` event are always cleaned up in `finally` blocks to
prevent permanent stalls. The SDK session has a hard timeout (180s/900s) that
forces cleanup even if the LLM never responds.

---

## 11. Profile Switching

When a profile switch is detected (LLM calls `switch_profile` or user says
"I'm Alex"):

1. New profile loaded from disk
   (`~/.config/local-finder/profiles/{name}/preferences.yaml`, saved places,
   history, ntfy subscriptions)
2. SDK session rebuilt with new system message (includes new profile's
   preferences, saved places, etc.)
3. System message shown: `Profile switched to: {name}`
4. Previous message replayed with new profile context
5. Status bar updated to show new profile name
6. `~/.config/local-finder/last_profile` updated so the profile persists
   across restarts

### 11.1 Mid-Conversation Profile Switch

If the user switches profiles mid-conversation:
- The chat area is NOT cleared — previous messages remain visible
- The LLM gets a new system message with the new profile's context
- The conversation continues seamlessly, but the LLM now uses the new
  profile's preferences (dietary, location, etc.)
- If the new profile has a different chat history, it is NOT loaded — the
  current session's history continues

### 11.2 Creating a New Profile

If the user says "switch to profile: newname" and the profile doesn't exist:
- A new profile directory is created with default preferences
- System message: `Created new profile: {name}`
- The user can then set preferences by saying "I'm vegetarian" etc.

---

## 12. Notification Delivery

On every submitted message (before sending to LLM):
- Check all subscribed ntfy.sh topics for new notifications
- If any: show as system message `🔔 {notifications}` above the response
- Happens asynchronously, does not block the prompt

### 12.1 Notifications During Streaming

If a notification arrives while the LLM is streaming a response:
- The notification is **queued**, not shown immediately (to avoid disrupting
  the streaming output)
- After the current response completes, queued notifications are displayed as
  system messages before the next prompt
- This prevents visual jarring during streaming

### 12.2 Alarm Delivery

When an alarm fires (set via `set_alarm`):
- Desktop notification via `notify-send` (if available)
- ntfy.sh push notification (if a reminders topic is subscribed)
- System message in the chat area: `⏰ Alarm: {message}`
- Alarms fire even if the user is mid-conversation

### 12.3 Calendar Reminders

Calendar event reminders fire at 1 hour and 30 minutes before the event:
- Desktop notification via `notify-send`
- ntfy.sh push notification
- These are implemented as self-destructing cron jobs — they fire even if
  Marvin is not running

---

## 13. Input Handling

### 13.1 Single-Line Input

The input box is a single line. There is no built-in multi-line input mode.

### 13.2 Paste Handling

- Pasting text into the input box works normally — the pasted text is
  inserted at the cursor position
- If the pasted text contains newlines, they are **stripped** (replaced with
  spaces) because the input is single-line
- Very large pastes (>10KB) should be truncated with a warning:
  `⚠️ Input truncated to 10,000 characters`
- Pasting is the primary way to input multi-line content (code blocks, etc.)
  — the newline stripping means the LLM receives it as a single paragraph,
  which is usually sufficient for conversational use

### 13.3 Unicode and Emoji

- Full Unicode support in both input and output (chat area)
- Emoji in messages display correctly (user can type or paste emoji)
- Tool names and system messages use emoji (🔧, 🔔, ⚠️, etc.)
- Terminal must support Unicode — if it doesn't, emoji may render as `?` or
  tofu characters (this is a terminal limitation, not a Marvin bug)
- Plain mode: emoji used for labels (`🔧`, `🔔`); these are ASCII-safe
  alternatives where needed (e.g., `[Tool]`, `[Alert]` if Unicode detection
  fails)

### 13.4 Input Length Limits

- **Soft limit**: 10,000 characters. Beyond this, a warning is shown:
  `⚠️ Input is very long. Consider using a file or shorter prompt.`
- **Hard limit**: None enforced by Marvin — but the LLM's context window is
  finite. Extremely long inputs will consume context budget and may cause
  compaction (see §10.3)
- The input box scrolls horizontally if the text exceeds the terminal width

### 13.5 Empty Input

- Pressing Enter with empty input does nothing (no message sent)
- Whitespace-only input is treated as empty

---

## 14. Accessibility

### 14.1 Plain Mode as Accessible Alternative

Plain mode (`--plain`) is the accessible alternative to the curses TUI:
- No cursor positioning or screen painting — works with screen readers
- Linear output: all messages printed sequentially to stdout
- Standard readline input: works with terminal accessibility tools
- ANSI colors used only when stdout is a TTY; omitted when piped
- All features available (see §3 feature parity guarantee)

### 14.2 Screen Reader Considerations

The curses TUI is **not screen reader friendly** due to:
- Full-screen cursor positioning
- Status bar updates that overwrite previous content
- Streaming character-by-character output

Users requiring screen reader support should use `--plain` mode.

### 14.3 Color and Contrast

- All colored elements use standard ANSI colors (not hardcoded RGB values)
  so they adapt to the user's terminal color scheme
- No information is conveyed by color alone — role labels (`You:`,
  `Assistant:`, `[System]`) provide text-based identification
- Error messages include `⚠️` or `❌` emoji in addition to red color

### 14.4 Keyboard-Only Navigation

The curses TUI is fully keyboard-navigable:
- No mouse required (mouse wheel scrolling is optional)
- All actions available via keyboard shortcuts (see §4)
- Focus never leaves the input box during normal operation (scrolling does
  not steal focus)

---

## 15. Provider Selection UX

### 15.1 Startup Provider

The LLM provider is selected at startup via:
1. `--provider` CLI flag (highest priority)
2. `LLM_PROVIDER` environment variable
3. Default: `copilot` (Copilot SDK)

### 15.2 Provider Indicator

The status bar shows the current provider and model:
```
🤖 claude-haiku-4.5 │ Profile: kevin │ ...
```

Provider emoji mapping:
- 🤖 — Copilot SDK
- 💎 — Gemini
- ⚡ — Groq
- 🦙 — Ollama
- 🔮 — OpenAI-compatible

### 15.3 Provider Fallback Notification

When a non-Copilot provider fails and Marvin falls back:
1. Yellow system message: `⚠️ {provider} error: {msg} — falling back to Copilot SDK`
2. Status bar updates to show the new provider
3. The prompt is retried automatically
4. The user does not need to re-type anything

### 15.4 `!pro` One-Shot Override

`!pro PROMPT` forces the Copilot SDK for a single query, regardless of the
configured provider. Useful for testing or when the current provider is having
issues. After the response, the original provider is restored.
