# Upstream Verification - 2026-06-13

Verified this plugin's API usage against a fresh shallow clone of
`anomalyco/opencode` (HEAD `73dbd8a`, 2026-06-12) and current OpenCode/OpenTUI
docs. Clone lives under the system temp directory only; do not vendor it.

## Plugin API surface

Every member this plugin uses exists on current main with the same shape:

- `api.keymap.registerLayer` with `commands` (namespace/name/title/category/
  suggested/slashName/slashAliases/run are open-ended command props read by
  the palette and slash handling) and `bindings`.
- `api.ui.DialogSelect` props: `title`, `placeholder`, `options`, `skipFilter`,
  `onFilter`, `onMove`, `onSelect` (plus `flat`, `current` we do not use).
  Internal-only props (`actions`, `footerHints`, `gutter`) are stripped by the
  plugin adapter, so per-row actions like the native picker's rename/delete
  are not expressible through the public `DialogSelect`.
- `api.ui.dialog.replace/clear/setSize`, `api.ui.toast`.
- `api.event.on`: all seven invalidation event names used here exist exactly
  (`session.updated`, `session.deleted`, `message.updated`, `message.removed`,
  `message.part.updated`, `message.part.removed`, `session.compacted`).
  Handlers also receive an undocumented second `{ directory, workspace }`
  metadata argument at runtime.
- `api.client.app.log({ service, level, message, extra })`.
- `api.client.session.list({ roots, search })` and
  `api.client.session.messages({ sessionID })`.
- `api.state.ready/session.count/session.messages/part`,
  `api.lifecycle.signal/onDispose`, `api.tuiConfig.keybinds.get`,
  `api.route.navigate("session", { sessionID })`, and all theme tokens used in
  `src/tui.tsx`.

The legacy `api.command` path is deprecated ("Remove in v2");
`keymap.registerLayer` is the current recommended path. `@opencode-ai/plugin`
versions in lockstep with opencode.

## Storage facts

- OpenCode core has no FTS5 anywhere. The sidecar FTS index is plugin-owned
  with no upstream pattern to mirror.
- `session.list`'s `search` parameter is a `LIKE %term%` match on the session
  title only, ordered by `time_updated desc`. Message/part content is never
  searched server-side, which is why this plugin keeps its own index.
- Session/message/part SQLite schema matches the assumptions in
  `src/search/source-db.ts` (the real `session` table has more columns than we
  read; all the ones we read exist).
- Channel DB naming: `opencode.db` for `latest`/`beta`/`prod` or when
  `OPENCODE_DISABLE_CHANNEL_DB` is set, else `opencode-<sanitized-channel>.db`.
  Caveat: `OPENCODE_CHANNEL` is a compile-time define in real builds; setting
  it at runtime only matters for source runs, which default to `local` anyway.

## OpenTUI notes

- All OpenTUI usages in `src/tui.tsx` are valid on current versions, but
  `scrollbarOptions={{ visible: false }}`, `wrapMode`, span `style={{ fg, bg }}`,
  and `KeyEvent.preventDefault/stopPropagation` are source-supported yet
  undocumented surfaces - re-verify them on OpenTUI upgrades.
- 0.2.x -> 0.4.x: no breaking changes flagged for scrollbox/box/text/
  useKeyboard; 0.4.0 swapped to native yoga-layout, so do a visual smoke test
  when bumping past 0.3.x. `viewportCulling` defaults to true since ~0.3.2.
