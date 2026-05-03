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
bun run test
```

`bun run test` currently runs the repo check suite. `bunfig.toml` also scopes bare Bun test discovery away from OpenCode/OpenTUI reference submodules in `upstream/`.

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

## Type Boundaries

OpenCode is the source of truth. Use types exported by OpenCode packages for
OpenCode-owned data:

- TUI/plugin API types from `@opencode-ai/plugin/tui`.
- Session/message/part/config types from `@opencode-ai/sdk/v2` when available.

Only define local types for plugin-owned concepts, such as sidecar DB rows,
search documents, ranked search results, dependency health, and picker UI state.
Do not duplicate OpenCode session/message/part shapes in this repo.

## Semantic Search Setup Plan

The sidecar search index is optional and derived. Fresh installs and upgrades
must keep the picker usable even when the sidecar, vector extension, or embedding
server is missing.

Fresh install behavior:

- `bun install` is enough for the current title-based picker.
- On first semantic-search run, create `opencode-search.db` outside OpenCode's
  DB and run idempotent sidecar migrations.
- Build FTS rows first so search works without model setup.
- Use vector search only after `sqlite-vec` loads and the embedding server
  passes a health/smoke test.
- Do not download model weights automatically from the TUI.

Existing install behavior:

- Read sidecar `index_meta` before querying vectors.
- Migrate compatible schema versions in place.
- Rebuild the sidecar when schema/extractor metadata is incompatible.
- Rebuild vectors when embedding model, dimensions, or prefixes change.
- Fall back to FTS/OpenCode API search if the embedding server is unavailable.

## Optional Local Embeddings

Recommended model: `nomic-ai/nomic-embed-text-v1.5-GGUF`.

Example download location:

```bash
mkdir -p "$HOME/.local/share/opencode-smart-session-picker/models"

huggingface-cli download \
  nomic-ai/nomic-embed-text-v1.5-GGUF \
  nomic-embed-text-v1.5.f16.gguf \
  --local-dir "$HOME/.local/share/opencode-smart-session-picker/models" \
  --local-dir-use-symlinks false
```

Start `llama-server`:

```bash
llama-server \
  -m "$HOME/.local/share/opencode-smart-session-picker/models/nomic-embed-text-v1.5.f16.gguf" \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ub 8192 \
  --host 127.0.0.1 \
  --port 8081
```

Minimal checks:

```bash
bun install
bun run typecheck
llama-server --help
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"search_query: test","model":"nomic-embed-text-v1.5","encoding_format":"float"}'
```

For disposable OpenCode plugin testing:

```bash
bun install --cwd upstream/opencode
bun run dev:opencode -- <workspace>
```

Omit `<workspace>` to open OpenCode against this repo. The dev launcher must
keep all disposable OpenCode config, data, state, cache, and sidecar files under
`.opencode-dev/`.
