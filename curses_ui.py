"""
Curses-based chat UI for Local Finder.

Provides a richer terminal experience with:
- Scrollable chat history with colored roles
- Fixed input bar at the bottom
- Status bar showing profile, tool activity, usage
- Proper word wrapping
"""

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
C_PURPLE = 8


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
    curses.init_pair(C_PURPLE, curses.COLOR_MAGENTA, -1)


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
        """Top status bar with live clock."""
        w = self.width
        # Clock with sun/moon emoji
        now = __import__('time').localtime()
        hour = now.tm_hour
        icon = "🌙" if hour >= 21 or hour < 6 else "☀️"
        clock = __import__('time').strftime(f" {icon} %I:%M:%S %p ", now)
        # Status on left, clock on right
        left_w = w - len(clock)
        if left_w < 0:
            left_w = 0
        bar = self.status_text[:left_w].ljust(left_w) + clock
        bar = bar[:w]
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

    def render_splash(self, art_path: str, duration: float = 2.0):
        """Show ASCII art splash screen in purple, then fade out."""
        try:
            with open(art_path) as f:
                lines = f.read().splitlines()
        except Exception:
            return

        h, w = self.height, self.width
        art_h = len(lines)
        art_w = max((len(l) for l in lines), default=0)
        y_off = max(0, (h - art_h) // 2)
        x_off = max(0, (w - art_w) // 2)
        color = curses.color_pair(C_PURPLE) | curses.A_BOLD

        self.stdscr.erase()
        for i, line in enumerate(lines):
            row = y_off + i
            if row >= h:
                break
            try:
                self.stdscr.addnstr(row, x_off, line, w - x_off, color)
            except curses.error:
                pass
        self.stdscr.refresh()

        # Hold for duration (non-blocking drain of input)
        self.stdscr.nodelay(True)
        end = time.time() + duration
        while time.time() < end:
            self.stdscr.getch()  # drain keypresses
            time.sleep(0.03)

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


# ── (Session logic now lives in app._run_curses_interactive) ─────────────────
