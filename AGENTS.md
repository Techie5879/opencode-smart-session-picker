# AGENTS.md

## Scope

This repo is a prototype OpenCode TUI plugin that replaces the built-in session picker command path.

## Commands

- Use `bun install` for dependencies.
- Use `bun run typecheck` for TypeScript validation.
- Use `bun run test` for the repo check suite: `tsc --noEmit` plus the integration tests under `test/integration`.
- `bunfig.toml` ignores `upstream/**` for bare Bun test discovery so submodule tests are not collected accidentally.
- Use `bun run dev:opencode -- <workspace>` to launch the plugin in upstream OpenCode without touching the user's real OpenCode config/state.
- Use `bun run test:perf` for deterministic fuzzy-search performance checks.
- Use `bun run test:perf:live` for opt-in readonly fuzzy-search benchmarks against the real local OpenCode database.

## Disposable OpenCode Plugin Testing

OpenCode's repo recommends `bun dev <directory>` as the local equivalent of the installed `opencode <directory>` command. For this plugin repo, do not edit `~/.config/opencode/tui.json` to test.

1. Install this repo's dependencies with `bun install`.
2. Install upstream OpenCode dependencies once with `bun install --cwd upstream/opencode`.
3. Run `bun run dev:opencode -- <workspace>` from this repo. Omit `<workspace>` to open OpenCode against this repo.
4. In the TUI, press `Ctrl-X` then `L`. The smart session picker should replace the built-in session list.

For manual smoke tests that need a workspace with many chats, pick a busy local workspace and pass it to the dev launcher:

```bash
bun run dev:opencode -- <busy-workspace>
```

The dev launcher writes only under `.opencode-dev/` in this repo and sets these environment variables for the child OpenCode process:

- `OPENCODE_TUI_CONFIG=.opencode-dev/tui.json`, containing a file plugin entry for `src/tui.tsx`.
- `OPENCODE_CONFIG_DIR=.opencode-dev/config`.
- `OPENCODE_TEST_HOME=.opencode-dev/home`.
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` under `.opencode-dev/xdg`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=true`, so project `.opencode` configs are not loaded during this disposable run.
- `OPENCODE_CHANNEL=local`, so plugin-side DB path resolution follows OpenCode's local channel database name.

The launcher preserves existing keys in `.opencode-dev/tui.json`. To try a disposable theme, edit that file directly; do not add code that reads from or copies the user's real global config on every run.

Current one-time local disposable theme copied for this machine: `lucent-orng` in `.opencode-dev/tui.json`.

Because the dev run isolates XDG data/state too, it will not show the user's real OpenCode sessions. That is intentional for safe plugin testing. Do not remove that isolation unless a task explicitly asks to test against real local OpenCode data.

## Real Local OpenCode Performance Testing

Only use the user's real OpenCode install when a task explicitly asks for real local database or live TUI comparison. Treat the user's global OpenCode configuration and status/state as read-only: do not edit `~/.config/opencode`, do not change installed plugin config, and do not mutate real session data to set up a test.

Allowed explicit workflows:

- Run readonly performance tests with `bun run test:perf:live`. The live benchmark requires `OPENCODE_SMART_PICKER_PERF_WORKSPACE` to point at a busy local workspace; it reads the real OpenCode SQLite database in readonly mode, filters to that workspace, and writes benchmark sidecar DBs only under the system temp directory.
- Use an existing tmux session/window or create a new tmux window to launch real `opencode <busy-workspace>` for manual TUI timing when the plugin is already installed. Keep any manual interaction limited to opening the session picker and running searches needed for performance measurement.
- For disposable plugin isolation, prefer `bun run dev:opencode -- <busy-workspace>`. For real installed-plugin comparison, do not copy or rewrite config; launch the existing real OpenCode setup as-is.

The live fuzzy-search benchmark should choose terms from the local OpenCode DB at runtime to cover high-hit and low-hit behavior. Do not commit real workspace paths, record IDs, session IDs, customer/project identifiers, or sampled query terms into this public repo.

## Boundaries

- Do not run tests inside `upstream/opencode` or `upstream/opentui` as part of this repo's normal checks.
- Treat `upstream/opencode` and `upstream/opentui` as read-only reference submodules unless a task explicitly asks to update submodule pins.
- Keep plugin source in `src/`.
- Keep the first implementation centered on the TUI plugin API. Avoid patching OpenCode core until plugin shadowing is proven insufficient.
- The only OpenCode behavior this plugin should override by default is the built-in session picker command path: search sessions and render the related picker dialog. Do not override, shadow, replace, rebind, wrap, or reimplement any other native OpenCode command, route, keybind, dialog, mutation flow, config behavior, storage behavior, theme behavior, model/provider behavior, prompt behavior, workspace behavior, or global TUI functionality unless the user explicitly asks for that exact change.
- Prefer native OpenCode APIs for everything outside the session picker replacement. If OpenCode already provides filtering, root-session selection, sorting, routing, mutation, or display data needed by the picker, call the native API instead of recreating it locally.
- Do not add extra command-palette entries or alternate plugin commands for this feature unless the user explicitly asks. The command registration should remain limited to shadowing the `session.list` command through `api.keymap.registerLayer`.
- Keep research notes in `docs/`. Session-storage research should focus on the current SQLite-backed `session`, `message`, and `part` tables.

## Implementation Notes

- The plugin shadows the built-in session picker by registering command `session.list` through `api.keymap.registerLayer`.
- Use public OpenCode TUI plugin APIs only. `api.ui.DialogSelect` is acceptable for simple picker rows; use `api.ui.dialog.replace` with OpenTUI primitives when the plugin needs distinct status/control surfaces.
- Search implementation lives under `src/search/`. Keep `src/tui.tsx` as a thin OpenTUI dialog wrapper around `searchSessions`, the mode selector, dependency status chips, and the session result list.
- The only OpenCode override is the built-in session picker command path and its related dialog. Do not add extra command palette entries, routes, keybind overrides, storage mutations, or config reads unless a task explicitly asks for them.
- Use OpenCode SDK/plugin types for OpenCode-owned data. Local types are allowed only for plugin-owned sidecar documents, ranking diagnostics, dependency health, and search configuration.
- The sidecar cache uses one shared connection (`openSharedSidecar`) with WAL + busy_timeout, and incremental session-level reindexing through `indexDelta`/`upsertSessions`. Do not reintroduce per-search `SearchSidecar.open` calls, per-keystroke meta writes, or full-corpus rebuilds on every invalidation event.
- External-content FTS5 rows must mirror the `document` content table exactly; clearing goes through the FTS5 `delete-all` command. Mismatched values corrupt the index (see the rebuild regression test).
- Keep `src/tui.tsx` lean: local code should exist only where OpenCode does not expose the native picker internals through the plugin API, or where the semantic search feature needs plugin-owned sidecar behavior.
