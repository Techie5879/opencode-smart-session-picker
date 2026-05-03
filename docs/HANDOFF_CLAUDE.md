# Handoff: Smart Session Picker TUI Status UI

## User Feedback

The current TUI status/mode UI is rejected.

The user specifically does **not** want:

- Search mode/dependency state rendered as normal selectable session rows.
- A large heavy status panel above the sessions.
- Orange/primary active fills that make mode chips look like selected sessions.
- A visually dominant block that competes with the session list.
- Long prose or noisy dependency text in the picker.

The latest user instruction: design is not required right now; leave a clear handoff.

## Current State

This repo is an OpenCode TUI plugin that shadows only the built-in session picker:

- command value: `session.list`
- keybind: `session_list`
- plugin entry: [src/tui.tsx](/Users/helios/opencode-smart-session-picker/src/tui.tsx)

Search implementation is under [src/search](/Users/helios/opencode-smart-session-picker/src/search).

Recent work added:

- [src/search/status.ts](/Users/helios/opencode-smart-session-picker/src/search/status.ts)
  - `checkSearchEnvironment({ mode })`
  - checks OpenCode DB, sidecar index, sqlite-vec, llama-server, and fzf
  - returns mode/dependency status data for the TUI
- [src/search/types.ts](/Users/helios/opencode-smart-session-picker/src/search/types.ts)
  - `SearchEnvironmentStatus`
  - `SearchModeStatus`
  - `SearchDependencyStatus`
  - `DependencyState` now includes `disabled` and `checking`
- [src/search/search.ts](/Users/helios/opencode-smart-session-picker/src/search/search.ts)
  - `searchSessions(api, query, { mode })` supports per-dialog mode override
- [test/integration/search.integration.test.ts](/Users/helios/opencode-smart-session-picker/test/integration/search.integration.test.ts)
  - integration test for status readiness with real temp files/fake fzf executable

The current [src/tui.tsx](/Users/helios/opencode-smart-session-picker/src/tui.tsx) uses OpenTUI primitives directly:

- `api.ui.dialog.replace`
- `<box>`
- `<text>`
- `<input>`
- `<scrollbox>`
- `useKeyboard`

This is technically valid, but the current visual treatment is bad and should be redesigned or reverted.

## Important Constraints

- Do not add another command, route, or keybind.
- Do not override any other OpenCode functionality.
- Keep OpenCode as the source of truth for session data and OpenCode-owned types.
- Use `@opencode-ai/sdk/v2` types for OpenCode data.
- Use local types only for plugin-owned search/status/sidecar data.
- Keep status/mode UI separate from the actual session result list.
- Do not make dependency/status rows selectable sessions.
- Avoid global max/limit constants unless the user explicitly asks.
- Treat `upstream/opencode`, `upstream/opentui`, `upstream/fzf`, and related upstream dirs as read-only references.

## Suggested Next Step

Either:

1. Revert `src/tui.tsx` back to the prior simple `DialogSelect` session picker and keep status data unused until design is specified.

or:

2. Keep the custom OpenTUI dialog but redesign the status as a very small, quiet toolbar:
   - one line under the search input
   - format like: `hybrid active | fzf ready | db missing | vec missing | llama missing`
   - use muted text for labels and only color tiny state words
   - no large panel
   - no borders unless extremely subtle
   - no active orange block
   - sessions must begin close below the search input

The user said design is not needed from this assistant now, so do not continue iterating visually unless asked.

## Verification Already Done

Before the handoff:

- `bun run typecheck` passed after the custom OpenTUI implementation.
- `bun run test` passed earlier with 5 integration tests.
- Disposable tmux smoke showed the plugin opens and `Tab` switches mode, but the visual result was rejected.

Run before finalizing any future change:

```bash
bun run typecheck
bun run test
```

For disposable visual smoke:

```bash
bun run dev:opencode -- .
```

Then press `Ctrl-X` followed by `L`.

