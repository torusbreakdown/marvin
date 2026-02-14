"""
Curses-based chat UI for Local Finder.

Provides a richer terminal experience with:
- Scrollable chat history with colored roles
- Fixed input bar at the bottom
- Status bar showing profile, tool activity, usage
- Proper word wrapping
"""

import asyncio
import curses
import os
import textwrap
import time


# ── Color pairs ──────────────────────────────────────────────────────────────

C_STATUS = 1
C_YOU = 2
C_ASSISTANT = 3
C_SYSTEM = 4
C_INPUT = 5
C_TOOL = 6
C_BORDER = 7


def _init_colors():
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(C_STATUS, curses.COLOR_BLACK, curses.COLOR_CYAN)
    curses.init_pair(C_YOU, curses.COLOR_GREEN, -1)
    curses.init_pair(C_ASSISTANT, curses.COLOR_CYAN, -1)
    curses.init_pair(C_SYSTEM, curses.COLOR_YELLOW, -1)
    curses.init_pair(C_INPUT, curses.COLOR_WHITE, -1)
    curses.init_pair(C_TOOL, curses.COLOR_MAGENTA, -1)
    curses.init_pair(C_BORDER, curses.COLOR_WHITE, -1)


# ── Chat message model ──────────────────────────────────────────────────────

class ChatMessage:
    __slots__ = ("role", "text", "timestamp")

    def __init__(self, role: str, text: str):
        self.role = role  # "you", "assistant", "system", "tool"
        self.text = text
        self.timestamp = time.strftime("%H:%M")


# ── Curses UI ────────────────────────────────────────────────────────────────

class CursesUI:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.messages: list[ChatMessage] = []
        self.input_buf = ""
        self.cursor_pos = 0
        self.scroll_offset = 0
        self.status_text = ""
        self.streaming_chunks: list[str] = []
        self.is_streaming = False
        self.input_history: list[str] = []
        self.history_idx = -1  # -1 = not browsing history
        self._saved_buf = ""   # saves current input when browsing history
        _init_colors()
        curses.curs_set(1)
        curses.raw()  # disable flow control so Ctrl+Q works
        stdscr.keypad(True)
        stdscr.nodelay(True)  # non-blocking getch

    def load_history(self, path: str):
        """Load readline-format history file into input history."""
        try:
            if os.path.exists(path):
                with open(path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("_HiStOrY_V2_"):
                            self.input_history.append(line)
        except Exception:
            pass

    @property
    def height(self):
        return self.stdscr.getmaxyx()[0]

    @property
    def width(self):
        return self.stdscr.getmaxyx()[1]

    def set_status(self, text: str):
        self.status_text = text

    def add_message(self, role: str, text: str):
        self.messages.append(ChatMessage(role, text))
        self.scroll_offset = 0  # auto-scroll to bottom

    def begin_stream(self):
        self.streaming_chunks.clear()
        self.is_streaming = True

    def stream_delta(self, delta: str):
        self.streaming_chunks.append(delta)

    def end_stream(self):
        text = "".join(self.streaming_chunks).strip()
        self.is_streaming = False
        if text:
            self.add_message("assistant", text)
        self.streaming_chunks.clear()

    def _wrap_lines(self, text: str, width: int) -> list[str]:
        """Word-wrap text to fit the chat area."""
        result = []
        for line in text.splitlines():
            if not line.strip():
                result.append("")
            else:
                result.extend(textwrap.wrap(line, width) or [""])
        return result

    def _role_color(self, role: str) -> int:
        return {
            "you": C_YOU,
            "assistant": C_ASSISTANT,
            "system": C_SYSTEM,
            "tool": C_TOOL,
        }.get(role, C_INPUT)

    def _role_label(self, role: str) -> str:
        return {
            "you": "You",
            "assistant": "Assistant",
            "system": "System",
            "tool": "Tool",
        }.get(role, role.title())

    def _render_chat(self):
        """Render scrollable chat area (rows 1 to height-3)."""
        h, w = self.height, self.width
        chat_top = 1
        chat_bottom = h - 3
        chat_height = chat_bottom - chat_top
        if chat_height < 1:
            return

        # Build all display lines from messages
        display_lines: list[tuple[str, int]] = []  # (text, color_pair)
        content_width = w - 2  # 1 char margin each side

        for msg in self.messages:
            color = curses.color_pair(self._role_color(msg.role))
            # Add ✓ to completed assistant messages
            if msg.role == "assistant":
                label = f"{msg.timestamp} ✓ {self._role_label(msg.role)}:"
            else:
                label = f"{msg.timestamp} {self._role_label(msg.role)}:"
            display_lines.append((label, color | curses.A_BOLD))
            for wl in self._wrap_lines(msg.text, content_width - 2):
                display_lines.append((f"  {wl}", color))
            display_lines.append(("", 0))

        # If currently streaming, show partial response with typing indicator
        if self.is_streaming:
            acolor = curses.color_pair(C_ASSISTANT)
            dots = "." * (1 + (int(time.time() * 3) % 3))
            if self.streaming_chunks:
                partial = "".join(self.streaming_chunks)
                display_lines.append((f"  ⟳ Assistant{dots}", acolor | curses.A_BOLD))
                for wl in self._wrap_lines(partial, content_width - 2):
                    display_lines.append((f"  {wl}", acolor))
            else:
                display_lines.append((f"  ⟳ Thinking{dots}", acolor | curses.A_BOLD))
            display_lines.append(("", 0))

        # Apply scroll offset (offset 0 = show bottom)
        total = len(display_lines)
        visible_start = max(0, total - chat_height - self.scroll_offset)
        visible_end = visible_start + chat_height
        visible = display_lines[visible_start:visible_end]

        for i, (text, attr) in enumerate(visible):
            row = chat_top + i
            if row >= chat_bottom:
                break
            try:
                self.stdscr.move(row, 1)
                self.stdscr.clrtoeol()
                self.stdscr.addnstr(text, w - 2, attr)
            except curses.error:
                pass

        # Clear remaining chat rows
        for i in range(len(visible), chat_height):
            row = chat_top + i
            if row < chat_bottom:
                try:
                    self.stdscr.move(row, 1)
                    self.stdscr.clrtoeol()
                except curses.error:
                    pass

        # Scroll indicator
        if total > chat_height and self.scroll_offset > 0:
            indicator = f" ↑ {self.scroll_offset} more "
            try:
                self.stdscr.addstr(chat_top, w - len(indicator) - 1, indicator,
                                   curses.color_pair(C_SYSTEM))
            except curses.error:
                pass

    def _render_status(self):
        """Top status bar."""
        w = self.width
        bar = self.status_text.ljust(w)[:w]
        try:
            self.stdscr.addstr(0, 0, bar, curses.color_pair(C_STATUS) | curses.A_BOLD)
        except curses.error:
            pass

    def _render_input(self):
        """Fixed input bar at the bottom (last 2 rows)."""
        h, w = self.height, self.width

        # Separator line
        try:
            self.stdscr.addstr(h - 3, 0, "─" * w, curses.color_pair(C_BORDER))
        except curses.error:
            pass

        # Input prompt
        prompt_str = "› "
        input_width = w - len(prompt_str) - 1
        try:
            self.stdscr.move(h - 2, 0)
            self.stdscr.clrtoeol()
            self.stdscr.addstr(prompt_str, curses.color_pair(C_YOU) | curses.A_BOLD)

            # Show visible portion of input buffer
            if len(self.input_buf) > input_width:
                visible_start = max(0, self.cursor_pos - input_width + 1)
                visible = self.input_buf[visible_start:visible_start + input_width]
                cursor_screen = self.cursor_pos - visible_start
            else:
                visible = self.input_buf
                cursor_screen = self.cursor_pos

            self.stdscr.addstr(visible, curses.color_pair(C_INPUT))

            # Help text on last row
            self.stdscr.move(h - 1, 0)
            self.stdscr.clrtoeol()
            help_text = " Enter: send | PgUp/PgDn: scroll | Ctrl+Q: quit "
            self.stdscr.addstr(help_text[:w - 1], curses.color_pair(C_STATUS))

            # Position cursor
            curses.curs_set(1)
            self.stdscr.move(h - 2, len(prompt_str) + cursor_screen)
        except curses.error:
            pass

    def render(self):
        """Full render cycle."""
        self.stdscr.erase()
        self._render_status()
        self._render_chat()
        self._render_input()
        self.stdscr.refresh()

    def handle_key(self, key: int) -> str | None:
        """Process a keypress. Returns the submitted text on Enter, else None."""
        if key == curses.KEY_RESIZE:
            self.render()
            return None
        elif key in (curses.KEY_ENTER, 10, 13):
            text = self.input_buf.strip()
            self.input_buf = ""
            self.cursor_pos = 0
            self.history_idx = -1
            if text:
                self.input_history.append(text)
            return text if text else None
        elif key in (curses.KEY_BACKSPACE, 127, 8):
            if self.cursor_pos > 0:
                self.input_buf = (
                    self.input_buf[:self.cursor_pos - 1]
                    + self.input_buf[self.cursor_pos:]
                )
                self.cursor_pos -= 1
        elif key == curses.KEY_DC:  # Delete
            if self.cursor_pos < len(self.input_buf):
                self.input_buf = (
                    self.input_buf[:self.cursor_pos]
                    + self.input_buf[self.cursor_pos + 1:]
                )
        elif key == curses.KEY_LEFT:
            if self.cursor_pos > 0:
                self.cursor_pos -= 1
        elif key == curses.KEY_RIGHT:
            if self.cursor_pos < len(self.input_buf):
                self.cursor_pos += 1
        elif key == curses.KEY_HOME or key == 1:  # Ctrl+A
            self.cursor_pos = 0
        elif key == curses.KEY_END or key == 5:  # Ctrl+E
            self.cursor_pos = len(self.input_buf)
        elif key == 21:  # Ctrl+U — clear line
            self.input_buf = ""
            self.cursor_pos = 0
        elif key == 11:  # Ctrl+K — kill to end of line
            self.input_buf = self.input_buf[:self.cursor_pos]
        elif key == curses.KEY_PPAGE:  # Page Up
            self.scroll_offset = min(
                self.scroll_offset + (self.height // 2),
                max(0, len(self.messages) * 4)  # rough upper bound
            )
        elif key == curses.KEY_NPAGE:  # Page Down
            self.scroll_offset = max(0, self.scroll_offset - (self.height // 2))
        elif key == curses.KEY_UP:
            # Browse input history
            if self.input_history:
                if self.history_idx == -1:
                    self._saved_buf = self.input_buf
                    self.history_idx = len(self.input_history) - 1
                elif self.history_idx > 0:
                    self.history_idx -= 1
                self.input_buf = self.input_history[self.history_idx]
                self.cursor_pos = len(self.input_buf)
        elif key == curses.KEY_DOWN:
            if self.history_idx != -1:
                if self.history_idx < len(self.input_history) - 1:
                    self.history_idx += 1
                    self.input_buf = self.input_history[self.history_idx]
                else:
                    self.history_idx = -1
                    self.input_buf = self._saved_buf
                self.cursor_pos = len(self.input_buf)
        elif 32 <= key <= 126 or key > 127:  # printable or unicode
            ch = chr(key) if key <= 0x10FFFF else ""
            self.input_buf = (
                self.input_buf[:self.cursor_pos]
                + ch
                + self.input_buf[self.cursor_pos:]
            )
            self.cursor_pos += len(ch)

        return None


# ── Main curses loop (called from app.py) ────────────────────────────────────

async def curses_main(stdscr, app_module):
    """Run the interactive loop inside curses."""
    import sys as _sys

    # Redirect stdout/stderr to a log file so library warnings
    # don't corrupt the curses display
    _log_path = os.path.join(
        os.path.expanduser("~/.config/local-finder"), "curses.log"
    )
    os.makedirs(os.path.dirname(_log_path), exist_ok=True)
    _log_file = open(_log_path, "a")
    _orig_stdout = _sys.stdout
    _orig_stderr = _sys.stderr
    _sys.stdout = _log_file
    _sys.stderr = _log_file

    ui = CursesUI(stdscr)

    # Load input history from profile
    hp = app_module._history_path()
    ui.load_history(hp)

    # Import what we need from the app module
    _active_profile = app_module._active_profile
    _prefs_path = app_module._prefs_path
    _build_system_message = app_module._build_system_message
    _usage = app_module._usage
    _save_history = app_module._save_history
    _save_last_profile = app_module._save_last_profile
    _check_all_subscriptions = app_module._check_all_subscriptions
    _load_saved_places = app_module._load_saved_places
    _list_profiles = app_module._list_profiles
    _exit_requested = app_module._exit_requested
    # Ensure the event exists (main() may not have initialized it)
    if app_module._profile_switch_requested is None:
        app_module._profile_switch_requested = asyncio.Event()
    _profile_switch_requested = app_module._profile_switch_requested

    from copilot import CopilotClient

    all_tools = [
        app_module.get_my_location, app_module.setup_google_auth,
        app_module.places_text_search, app_module.places_nearby_search,
        app_module.estimate_travel_time, app_module.estimate_traffic_adjusted_time,
        app_module.web_search, app_module.get_usage,
        app_module.search_papers, app_module.search_arxiv,
        app_module.search_movies, app_module.get_movie_details,
        app_module.search_games, app_module.get_game_details,
        app_module.scrape_page, app_module.browse_web,
        app_module.save_place, app_module.remove_place, app_module.list_places,
        app_module.set_alarm, app_module.list_alarms, app_module.cancel_alarm,
        app_module.generate_ntfy_topic, app_module.ntfy_subscribe,
        app_module.ntfy_unsubscribe, app_module.ntfy_publish, app_module.ntfy_list,
        app_module.switch_profile, app_module.update_preferences, app_module.exit_app,
        app_module.write_note, app_module.read_note,
        app_module.notes_mkdir, app_module.notes_ls,
        app_module.yt_dlp_download,
        app_module.calendar_add_event, app_module.calendar_delete_event,
        app_module.calendar_view, app_module.calendar_list_upcoming,
    ]

    def update_status():
        profile = app_module._active_profile
        n_msgs = len(ui.messages)
        subs = len(app_module._load_ntfy_subs())
        status = (
            f" Local Finder │ Profile: {profile} │ "
            f"Messages: {n_msgs} │ Subs: {subs} │ "
            f"{_usage.summary_oneline()}"
        )
        ui.set_status(status)

    client = CopilotClient()
    await client.start()

    session = await client.create_session({
        "model": "gpt-5.2",
        "tools": all_tools,
        "system_message": {"content": _build_system_message()},
    })

    done = asyncio.Event()
    busy = False

    def on_event(event):
        nonlocal busy
        etype = event.type.value
        if etype == "assistant.message_delta":
            delta = event.data.delta_content or ""
            ui.stream_delta(delta)
            ui.render()
        elif etype == "assistant.message":
            _usage.record_llm_turn()
            if not ui.streaming_chunks and hasattr(event.data, 'content') and event.data.content:
                text = event.data.content
                ui.add_message("assistant", text)
                app_module._append_chat("assistant", text)
            else:
                text = "".join(ui.streaming_chunks).strip()
                ui.end_stream()
                if text:
                    app_module._append_chat("assistant", text)
            update_status()
            ui.render()
        elif etype == "session.idle":
            if ui.is_streaming:
                ui.end_stream()
            busy = False
            done.set()
            ui.render()

    session.on(on_event)

    # Show history summary or welcome message
    chat_log = app_module._load_chat_log()
    if chat_log:
        recent = chat_log[-20:]
        lines = []
        for entry in recent:
            role = entry.get("role", "?")
            text = entry.get("text", "")
            if len(text) > 200:
                text = text[:200] + "…"
            prefix = "You" if role == "you" else "Assistant"
            lines.append(f"  {prefix}: {text}")
        summary = "\n".join(lines)
        ui.add_message("system",
            f"Welcome back! Profile: {app_module._active_profile}\n"
            f"Recent conversation:\n{summary}\n\n"
            f"PgUp/PgDn to scroll. ↑↓ for input history. Ctrl+Q to quit."
        )
    else:
        ui.add_message("system",
            f"Welcome to Local Finder!\n"
            f"Profile: {app_module._active_profile}\n"
            f"Type your message below. PgUp/PgDn to scroll. Ctrl+Q to quit."
        )
    update_status()
    ui.render()

    queued_prompt = None

    try:
        while True:
            if _exit_requested.is_set():
                break

            key = stdscr.getch()

            if key == 4 or key == 17:  # Ctrl+D or Ctrl+Q
                break

            if key != -1 and not busy:
                submitted = ui.handle_key(key)
                ui.render()

                if submitted is not None:
                    # Handle local commands
                    lower = submitted.lower()
                    if lower in ("quit", "exit"):
                        break
                    elif lower == "preferences":
                        ui.add_message("system",
                            f"Preferences file: {_prefs_path()}\n"
                            f"(Edit preferences from the regular terminal mode.)")
                        ui.render()
                    elif lower == "profiles":
                        ui.add_message("system",
                            f"Active: {app_module._active_profile}\n"
                            f"Available: {', '.join(_list_profiles())}")
                        ui.render()
                    elif lower == "usage":
                        ui.add_message("system",
                            f"{_usage.summary()}\n{_usage.lifetime_summary()}")
                        ui.render()
                    elif lower == "saved":
                        places = _load_saved_places()
                        if not places:
                            ui.add_message("system", "No saved places yet.")
                        else:
                            lines = [f"Saved places ({len(places)}):"]
                            for p in places:
                                name = p.get("label", "?").upper()
                                if p.get("name"):
                                    name += f" — {p['name']}"
                                lines.append(name)
                                if p.get("address"):
                                    lines.append(f"  📍 {p['address']}")
                            ui.add_message("system", "\n".join(lines))
                        ui.render()
                    else:
                        # Check ntfy before sending
                        try:
                            notifs = await _check_all_subscriptions()
                            if notifs:
                                ui.add_message("system", f"🔔 {notifs}")
                        except Exception:
                            pass

                        # Send to LLM
                        ui.add_message("you", submitted)
                        app_module._append_chat("you", submitted)
                        ui.begin_stream()
                        update_status()
                        ui.render()

                        done.clear()
                        busy = True
                        await session.send({"prompt": submitted})

            elif key != -1 and busy:
                # Allow typing and scrolling while waiting for response
                if key == 4 or key == 17:
                    break
                result = ui.handle_key(key)
                if result is not None:
                    queued_prompt = result  # queue for after response
                ui.render()

            # Check if response just finished
            if done.is_set() and busy:
                busy = False
                # Handle profile switch
                if _profile_switch_requested.is_set():
                    _profile_switch_requested.clear()
                    await session.destroy()
                    session = await client.create_session({
                        "model": "gpt-5.2",
                        "tools": all_tools,
                        "system_message": {"content": _build_system_message()},
                    })
                    session.on(on_event)
                    ui.add_message("system",
                        f"Session rebuilt for profile: {app_module._active_profile}")

                    # Re-send prompt
                    done.clear()
                    busy = True
                    ui.begin_stream()
                    await session.send({"prompt": submitted})

                update_status()
                ui.render()

                # Process queued prompt if any
                if queued_prompt and not busy:
                    submitted = queued_prompt
                    queued_prompt = None
                    ui.add_message("you", submitted)
                    app_module._append_chat("you", submitted)
                    ui.begin_stream()
                    update_status()
                    ui.render()
                    done.clear()
                    busy = True
                    await session.send({"prompt": submitted})
            await asyncio.sleep(0.03)

            update_status()
            ui.render()
    finally:
        # Save curses input history in readline-compatible format
        try:
            if ui.input_history:
                os.makedirs(os.path.dirname(hp), exist_ok=True)
                with open(hp, "w") as f:
                    f.write("_HiStOrY_V2_\n")
                    for line in ui.input_history[-1000:]:
                        f.write(line + "\n")
        except Exception:
            pass
        _save_last_profile()
        _usage.save()
        await session.destroy()
        await client.stop()

        # Restore stdout/stderr
        _sys.stdout = _orig_stdout
        _sys.stderr = _orig_stderr
        _log_file.close()
