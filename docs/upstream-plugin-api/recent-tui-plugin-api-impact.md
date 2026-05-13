# Recent OpenCode TUI Plugin API Impact

Inspected `upstream/opencode` at `ca17ca85c` on 2026-05-13, focusing on
commits touching `packages/plugin`, `packages/opencode/src/cli/cmd/tui/plugin`,
TUI keymaps, and TUI config.

## Relevant Commits

- `98f5e6e71` - `introduce opentui keymap as sole key/cmd engine (#26053)`
- `a0fc27e42` - `flatten to keybind compatible config (#26421)`
- `9a8b54fe6` - `Plugin command API shim (#26564)`
- `a5c35bf18` - `Avoid bootstrapping server plugins from TUI plugin runtime (#26938)`
- `46edc98f1` - `Validate TUI config with Effect Schema (#26952)`
- `d6367853a` - `Add TUI notifications and attention sounds (disabled by default) (#26980)`
- `f13fc5a8a` - `refactor(flags): route event system through runtime flags (#27323)`

## Current API Surface For This Plugin

### Command Shadowing

OpenCode now routes TUI commands through the OpenTUI keymap engine. The native
session picker is registered as command `session.list`.

Use:

- Use `api.keymap.registerLayer({ commands: [...] })` to shadow `session.list`.

Current repo status:

- `src/tui.tsx` registers command `session.list` through `api.keymap`.
- `package.json` pins current plugin/OpenTUI types so `api.keymap` typechecks.

### Keybind Config Is Flattened

TUI keybinds are now exposed through `api.tuiConfig.keybinds`, with helpers such
as `get`, `has`, `gather`, `pick`, and `omit`.

Use:

- If this plugin needs display text for shortcuts, use `api.tuiConfig.keybinds`
  and `api.keys.formatSequence` / `api.keys.formatBindings`.
- Treat `session.list` as the command identity when runtime keybind display is
  needed.

Current repo status:

- The plugin does not currently render the session-list shortcut, so no change is
  needed beyond the `api.keymap` command registration.

### TUI Config Validation Is Stricter

TUI config now goes through Effect Schema validation.

Impact:

- Keep `~/.config/opencode/tui.json` and `.opencode-dev/tui.json` minimal and
  schema-shaped.
- For no-plugin benchmarks, use a valid empty config:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": []
}
```

### Runtime Plugin Loading

The TUI plugin runtime no longer bootstraps server plugins.

Impact:

- This repo is correctly a TUI-only plugin exporting `tui`.
- Do not add server plugin behavior to this package to support the session picker.

### `api.attention` Was Added

TUI plugins can now call `api.attention.notify(...)` and register sound packs.

Impact:

- No required change. The smart session picker should not emit notifications or
  sounds during normal search/open flows.
- If future background indexing becomes user-visible, `api.attention` is the
  upstream-supported API for opt-in notifications.

### Runtime Flags Refactor

Recent runtime-flag changes affect how internal TUI plugins are selected, but do
not change the public API this repo uses.

Impact:

- No code change needed.
- Continue relying on public `@opencode-ai/plugin/tui` types, not internal TUI
  runtime files.

## Current Compatibility Checklist

- Shadow command: `session.list` via `api.keymap.registerLayer`.
- Keep plugin source TUI-only: `src/tui.tsx`.
- Validate after upstream updates: `bun update @opencode-ai/plugin @opencode-ai/sdk @opentui/core @opentui/solid solid-js` then `bun run typecheck`.
