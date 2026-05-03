# opencode-smart-session-picker

Prototype OpenCode TUI plugin that shadows the built-in `session.list` command used by `Ctrl-X L`.

This version still uses OpenCode's normal session API, so search is title-based. The important part is the hook: the plugin registers its own hidden command with `value: "session.list"` and `keybind: "session_list"`. Because TUI plugin command registrations are prepended, this should win over the built-in picker in normal TUI contexts.

## Install Locally

From this repo:

```bash
bun install
```

Useful checks:

```bash
bun run typecheck
bun test
```

`bun test` is scoped by `bunfig.toml` to this repo's `test/` directory, so it does not collect tests from the OpenCode/OpenTUI reference submodules in `upstream/`.

Add it to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/helios/opencode-smart-session-picker"]
}
```

Restart `opencode`, then press `Ctrl-X` followed by `L`.

## Where Hybrid Search Goes

The replacement point is `searchSessions` in `src/tui.tsx`. Swap that function to query a local index/vector store, then map results back into `TuiDialogSelectOption<string>` rows.

Expected next steps:

- Add an indexer that watches/session-syncs OpenCode storage.
- Store title, timestamps, session id, and message/content embeddings.
- Replace title-only SDK search with hybrid retrieval.
- Add delete and rename key actions once the base picker hook is proven.
