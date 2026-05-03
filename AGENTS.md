# AGENTS.md

## Scope

This repo is a prototype OpenCode TUI plugin that replaces the built-in session picker command path.

## Commands

- Use `bun install` for dependencies.
- Use `bun run typecheck` for TypeScript validation.
- Use `bun test` for the repo check suite. Right now this intentionally runs `tsc --noEmit`.
- Use `bun run dev:opencode -- <workspace>` to launch the plugin in upstream OpenCode without touching the user's real OpenCode config/state.

## Disposable OpenCode Plugin Testing

OpenCode's repo recommends `bun dev <directory>` as the local equivalent of the installed `opencode <directory>` command. For this plugin repo, do not edit `~/.config/opencode/tui.json` to test.

1. Install this repo's dependencies with `bun install`.
2. Install upstream OpenCode dependencies once with `bun install --cwd upstream/opencode`.
3. Run `bun run dev:opencode -- <workspace>` from this repo. Omit `<workspace>` to open OpenCode against this repo.
4. In the TUI, press `Ctrl-X` then `L`. The smart session picker should replace the built-in session list.

The dev launcher writes only under `.opencode-dev/` in this repo and sets these environment variables for the child OpenCode process:

- `OPENCODE_TUI_CONFIG=.opencode-dev/tui.json`, containing a file plugin entry for `src/tui.tsx`.
- `OPENCODE_CONFIG_DIR=.opencode-dev/config`.
- `OPENCODE_TEST_HOME=.opencode-dev/home`.
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` under `.opencode-dev/xdg`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=true`, so project `.opencode` configs are not loaded during this disposable run.

The launcher preserves existing keys in `.opencode-dev/tui.json`. To try a disposable theme, edit that file directly; do not add code that reads from or copies the user's real global config on every run.

Current one-time local disposable theme copied for this machine: `lucent-orng` in `.opencode-dev/tui.json`.

Because the dev run isolates XDG data/state too, it will not show the user's real OpenCode sessions. That is intentional for safe plugin testing. Do not remove that isolation unless a task explicitly asks to test against real local OpenCode data.

## Boundaries

- Do not run tests inside `upstream/opencode` or `upstream/opentui` as part of this repo's normal checks.
- Treat `upstream/opencode` and `upstream/opentui` as read-only reference submodules unless a task explicitly asks to update submodule pins.
- Keep plugin source in `src/`.
- Keep the first implementation centered on the TUI plugin API. Avoid patching OpenCode core until plugin shadowing is proven insufficient.
- Keep research notes in `docs/`. Session-storage research should focus on the current SQLite-backed `session`, `message`, and `part` tables, not the older JSON session files.

## Implementation Notes

- The plugin shadows the built-in session picker by registering `value: "session.list"` and `keybind: "session_list"`.
- `api.ui.DialogSelect` is the preferred first UI surface because it is the public OpenCode TUI plugin dialog API.
- The future hybrid/vector search integration should replace `searchSessions` in `src/tui.tsx`, not the command registration path.
