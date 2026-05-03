# AGENTS.md

## Scope

This repo is a prototype OpenCode TUI plugin that replaces the built-in session picker command path.

## Commands

- Use `bun install` for dependencies.
- Use `bun run typecheck` for TypeScript validation.
- Use `bun test` for the repo check suite. Right now this intentionally runs `tsc --noEmit`.
- `bunfig.toml` scopes Bun test discovery to `test/` so upstream submodule tests are not collected.

## Boundaries

- Do not run tests inside `upstream/opencode` or `upstream/opentui` as part of this repo's normal checks.
- Treat `upstream/opencode` and `upstream/opentui` as read-only reference submodules unless a task explicitly asks to update submodule pins.
- Keep plugin source in `src/`.
- Keep the first implementation centered on the TUI plugin API. Avoid patching OpenCode core until plugin shadowing is proven insufficient.

## Implementation Notes

- The plugin shadows the built-in session picker by registering `value: "session.list"` and `keybind: "session_list"`.
- `api.ui.DialogSelect` is the preferred first UI surface because it is the public OpenCode TUI plugin dialog API.
- The future hybrid/vector search integration should replace `searchSessions` in `src/tui.tsx`, not the command registration path.
