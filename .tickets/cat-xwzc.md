---
id: cat-xwzc
status: open
deps: []
links: []
created: 2026-02-16T19:46:54Z
type: epic
priority: 0
assignee: kmd
---
# Rewrite Marvin as a production-grade Node.js/TypeScript application. Read ALL files in .marvin/upstream/ carefully:

- MARVIN_API_SPEC.md: The authoritative integration contract. Your implementation MUST support this exact interface — the same CLI flags, the same stdin/stdout protocol, the same tool call format, the same environment variables. A web UI built against this spec must work identically with your Node.js version as it does with the Python original.
- README.md and REFERENCE.md: Feature overview and command reference for the original Marvin.
- WEB_SPEC.md and WEB_DESIGN.md: The spec and architecture for a web frontend being built separately. Your Node.js Marvin must be a drop-in replacement — the web UI spawns Marvin as a subprocess and communicates via stdin/stdout per MARVIN_API_SPEC.md. If the web UI works with the Python Marvin, it must work identically with yours.

Key requirements:
1. **Exact CLI compatibility**: same flags (--non-interactive, --working-dir, --model, --prompt, --ntfy, etc.), same exit codes, same stdout JSON protocol for non-interactive mode, same interactive mode behavior.
2. **Same tool interface**: implement the same tools (read_file, create_file, apply_patch, run_command, code_grep, tree, git_status, git_diff, git_commit, tk, etc.) with the same parameter schemas and return formats.
3. **Multi-provider LLM support**: OpenAI, Anthropic, Google Gemini, Ollama — same env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY), same model selection logic.
4. **Production-grade**: proper error handling, graceful shutdown, structured logging, TypeScript throughout, clean module architecture (not one giant file), comprehensive test suite.
5. **Node.js ecosystem**: use Express or Fastify, proper async/await, streaming support, npm package management.
6. **Do NOT read or reference the Python source code** — implement from the spec only. This is a clean-room rewrite.

VISUAL DESIGN — Beautiful Retro Terminal Aesthetic:
The interactive terminal UI must look like a beautiful 1980s terminal with a vaporwave aesthetic. Think CRT monitors, phosphor glow, and retro-futurism:

- **Color palette**: Deep blacks (#0a0a0a), phosphor green (#00ff41), amber (#ffb000), cyan (#00e5ff), magenta/pink (#ff00ff, #ff69b4) accents. Vaporwave gradients for emphasis.
- **Typography**: Monospace throughout. Use Unicode box-drawing characters (─│┌┐└┘├┤┬┴┼) for borders, panels, and status bars. Double-line borders (═║╔╗╚╝) for important sections.
- **CRT effects in terminal**: Subtle use of ANSI dim/bright to simulate scanline feel. Blinking cursor. Slow-reveal text for dramatic moments (character-by-character for short messages).
- **Status bars**: Top and bottom bars with retro styling — system status, model info, cost tracker. Use block characters (█▓▒░) for progress bars.
- **ASCII art**: Marvin logo in ASCII art on startup. Use figlet-style headers for phase transitions.
- **Personality**: Marvin is the Paranoid Android. Sardonic, world-weary loading messages: "I've been asked to think about this. I suppose I must.", "Brain the size of a planet and they want me to write specs...", "Here I am, brain the size of a planet, debugging JavaScript."
- **Sound cues via terminal bell**: \a on errors and phase completions.
- **Spinners**: Retro-styled spinners using braille characters or classic |/-\ for thinking indicators.

The litmus test: start your Node.js Marvin with `node dist/app.js --non-interactive --working-dir /some/dir --prompt "hello"` and it should produce output indistinguishable from the Python version. The web UI should be able to swap `python app.py` for `node dist/app.js` and work without changes.


