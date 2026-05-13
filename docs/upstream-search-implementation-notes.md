# Upstream Search Implementation Notes

These notes capture the read-only upstream reconnaissance used for the smart
session picker implementation.

## OpenCode Boundary

- Public TUI plugin types come from `@opencode-ai/plugin/tui`.
- Public OpenCode domain types come from `@opencode-ai/sdk/v2`.
- The plugin should import `Session`, `Message`, and `Part` from the SDK instead
  of defining local OpenCode-shaped types.
- The only OpenCode command path this plugin shadows is `session.list`, registered
  through `api.keymap.registerLayer`.
- Public plugin dialogs expose `DialogSelect`, `DialogPrompt`, `DialogConfirm`,
  and `DialogAlert`. Internal picker affordances such as gutters and background
  colors are not public plugin API.
- Session selection must continue to use
  `api.route.navigate("session", { sessionID })`.
- Session display metadata should be hydrated from `api.client.session.list`.
  The sidecar only ranks candidate session IDs.

Relevant upstream files:

- `upstream/opencode/packages/plugin/src/tui.ts`
- `upstream/opencode/packages/sdk/js/src/v2/gen/types.gen.ts`
- `upstream/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
- `upstream/opencode/packages/opencode/src/session/session.sql.ts`
- `upstream/opencode/packages/opencode/src/session/message-v2.ts`

## fzf Boundary

- `fzf --filter <query>` is the supported non-interactive mode.
- Exit code `0` means matches were printed. Exit code `1` means no match and is
  expected control flow. Exit code `2` is an error.
- Use NUL-delimited records with `--read0 --print0`.
- Use tab-delimited fields with `--delimiter "\t"`.
- Use `--with-nth 2..` to search visible text while retaining the original
  record.
- Use `--accept-nth 1` so stdout contains only session IDs.
- Unset `FZF_DEFAULT_OPTS` and `FZF_DEFAULT_OPTS_FILE` for deterministic plugin
  behavior.

Recommended invocation:

```text
fzf --read0 --print0 --filter <query> --scheme=history --delimiter "\t" --with-nth 2.. --accept-nth 1
```

Relevant upstream files:

- `upstream/fzf/src/core.go`
- `upstream/fzf/src/constants.go`
- `upstream/fzf/src/options.go`
- `upstream/fzf/man/man1/fzf.1`
- `upstream/fzf/test/test_filter.rb`

## sqlite-vec And Bun SQLite

- The first implementation keeps vector search optional.
- `bun:sqlite` can create the sidecar and FTS5 tables directly.
- sqlite-vec can be loaded with the `sqlite-vec` JS package when installed, or
  with a local extension path if explicitly configured.
- On macOS, Bun may need `Database.setCustomSQLite(...)` before opening a
  database if the system SQLite cannot load extensions.
- `vec0` tables use `create virtual table ... using vec0(embedding float[N])`.
- Query vectors can be bound as `Float32Array`.

Relevant upstream files:

- `upstream/sqlite-vec/site/using/js.md`
- `upstream/sqlite-vec/site/features/knn.md`
- `upstream/sqlite-vec/examples/simple-bun/demo.ts`
- `node_modules/bun-types/sqlite.d.ts`

## llama.cpp Embeddings

- The intended local server is `llama-server --embedding --pooling mean`.
- Health checks can use `/health` or `/v1/health`.
- Embeddings should use OpenAI-compatible `POST /v1/embeddings`.
- The response dimension is discovered from the first successful embedding and
  stored in sidecar metadata. Changing dimensions makes vector rows stale.

Relevant upstream files:

- `upstream/llama.cpp/tools/server/README.md`
- `upstream/llama.cpp/tools/server/server.cpp`
- `upstream/llama.cpp/tools/server/server-context.cpp`
- `upstream/llama.cpp/tools/server/server-common.cpp`
- `upstream/llama.cpp/tools/server/tests/unit/test_embedding.py`
