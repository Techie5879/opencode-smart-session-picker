# Recent OpenCode TUI Plugin API Impact

Inspected `upstream/opencode` at `27ac53aaa` on 2026-05-14, focusing on
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
- `27ac53aaa` update range includes generated SDK/API releases through
  `v1.14.50`, plus event HTTP API refactors and TUI keymap fallback fixes.

## Current API Surface For This Plugin

### Command Shadowing

OpenCode now routes TUI commands through the OpenTUI keymap engine. The native
session picker is registered as command `session.list`.

Use:

- Use `api.keymap.registerLayer({ commands: [...] })` to shadow `session.list`.
- Palette-visible commands should set `namespace: "palette"`. The native
  command also exposes slash metadata: `slashName: "sessions"` and aliases
  `resume` / `continue`.

Current repo status:

- `src/tui.tsx` registers command `session.list` through `api.keymap` with
  `namespace: "palette"`, slash metadata, and suggested-state metadata.
- `package.json` pins current plugin/sdk `1.14.50` packages and OpenTUI
  `0.2.9` packages. `@opentui/keymap` is listed directly because the public
  plugin API exposes keymap types through that peer.

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

### Synced State And Event Stream

The public API now exposes enough host state and events to avoid some redundant
SDK reads and to keep plugin-owned sidecar data fresh:

- `api.state.session.messages(sessionID)` and `api.state.part(messageID)` expose
  already-synced TUI messages and parts.
- `api.event.on(type, handler)` exposes session/message lifecycle events.
- `api.lifecycle.signal` and `api.lifecycle.onDispose(...)` are the public
  cleanup/cancellation surfaces for plugin work.

Current repo status:

- `src/search/preview.ts` tries synced TUI state first for previews, then falls
  back to `api.client.session.messages(...)`.
- `src/search/search.ts` registers index invalidation for session/message update,
  delete/remove, part update/remove, and compaction events.
- Background indexing checks `api.lifecycle.signal` and avoids marking stale
  index generations as complete.

Weirdness:

- Synced TUI state is not guaranteed to contain full historical session content.
  It is a preview fast path only; the SDK fallback remains required.
- `api.event.on(...)` returns unsubscribers. Keymap registrations are scoped by
  the plugin runtime, but event subscriptions still need explicit lifecycle
  cleanup.

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

- Shadow command: `session.list` via `api.keymap.registerLayer` and
  `namespace: "palette"`.
- Keep plugin source TUI-only: `src/tui.tsx`.
- Validate after upstream updates: `bun update @opencode-ai/plugin @opencode-ai/sdk @opentui/core @opentui/keymap @opentui/solid solid-js` then `bun run typecheck`.
