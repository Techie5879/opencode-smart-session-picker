# Semantic Session Search Plan

## Goal

Build an end-to-end semantic OpenCode session picker that keeps OpenCode's
SQLite database read-only, maintains a sidecar hybrid search index, and uses
the existing TUI plugin command shadowing path.

The target architecture is:

```text
opencode.db
  read-only source of truth: session, message, part

opencode-search.db
  sidecar index: metadata, extracted documents, FTS5, sqlite-vec

llama.cpp
  local embedding server, OpenAI-compatible /v1/embeddings

TUI plugin
  query sidecar, rank results, navigate through OpenCode API
```

## Reference Submodules

- [x] Add `upstream/sqlite-vec` for local vector search reference code.
- [x] Add `upstream/llama.cpp` for local embedding server reference code.
- [ ] Keep model-weight repositories out of git submodules.
- [ ] Document recommended external model download separately.

## Recommended Initial Defaults

- Embedding runtime: `llama.cpp` `llama-server`.
- Embedding endpoint: `http://127.0.0.1:8081/v1/embeddings`.
- Embedding model: `nomic-embed-text-v1.5-GGUF`.
- Embedding dimensions: `768`.
- Document prefix: `search_document: `.
- Query prefix: `search_query: `.
- Vector table: `sqlite-vec` `vec0` with `float[768]`.
- Lexical table: SQLite FTS5.
- Fusion: reciprocal rank fusion over FTS and vector result ranks.

Example local embedding server:

```bash
llama-server \
  -m /path/to/nomic-embed-text-v1.5.f16.gguf \
  --embedding \
  --pooling mean \
  -c 8192 \
  -ub 8192 \
  --host 127.0.0.1 \
  --port 8081
```

## Non-Goals

- Do not patch OpenCode core for the first implementation.
- Do not write search tables into OpenCode's database.
- Do not edit or read the user's real global OpenCode config during disposable
  plugin testing.
- Do not index live `message.part.delta` bus events as durable content.
- Do not submodule GGUF model artifacts.

## Phase 1: Configuration And Boundaries

- [ ] Define search configuration in `src/`, with environment overrides:
  - [ ] `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [ ] `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [ ] `OPENCODE_SMART_PICKER_EMBED_BASE_URL`.
  - [ ] `OPENCODE_SMART_PICKER_EMBED_MODEL`.
  - [ ] `OPENCODE_SMART_PICKER_EMBED_DIMENSIONS`.
  - [ ] `OPENCODE_SMART_PICKER_DISABLE_VECTOR`.
- [ ] Resolve the source OpenCode database path:
  - [ ] Prefer explicit `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [ ] Then honor `OPENCODE_DB` if present.
  - [ ] In disposable dev, use the isolated `.opencode-dev` data path.
  - [ ] Avoid guessing the user's global OpenCode database in tests.
- [ ] Resolve the sidecar search database path:
  - [ ] Prefer explicit `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [ ] Default next to the source DB as `opencode-search.db`.
  - [ ] In disposable dev, keep it under `.opencode-dev/`.
- [ ] Add a visible fallback state when the sidecar is missing or stale.

## Phase 2: Sidecar Schema

- [ ] Add a module that opens `opencode-search.db` with `bun:sqlite`.
- [ ] Load `sqlite-vec` only for the sidecar connection.
- [ ] Create idempotent migrations for:
  - [ ] `index_meta(key text primary key, value text not null)`.
  - [ ] `source_state(source_db_fingerprint text, last_full_reconcile integer)`.
  - [ ] `indexed_session(session_id text primary key, project_id text, workspace_id text, parent_id text, directory text, path text, title text, time_created integer, time_updated integer, time_archived integer, source_hash text, indexed_at integer)`.
  - [ ] `document(rowid integer primary key, doc_id text unique, session_id text not null, message_id text, part_id text, chunk_index integer not null default 0, role text, part_type text, synthetic integer, ignored integer, text text not null, metadata_json text not null, source_hash text not null, indexed_at integer not null)`.
  - [ ] `document_fts using fts5(title, path, role, part_type, text, content='document', content_rowid='rowid')`.
  - [ ] `document_vec using vec0(embedding float[768])`.
- [ ] Store model metadata in `index_meta`:
  - [ ] embedding provider.
  - [ ] embedding base URL.
  - [ ] embedding model name.
  - [ ] dimensions.
  - [ ] document/query prefixes.
  - [ ] extractor version.
  - [ ] schema version.
- [ ] Force a vector rebuild when model, dimensions, prefixes, or extractor
  version changes.
- [ ] Add delete paths that remove rows from `document`, `document_fts`, and
  `document_vec` together.

## Phase 3: Source DB Reader

- [ ] Open the OpenCode database in read-only mode.
- [ ] Read only current projected tables:
  - [ ] `session`.
  - [ ] `message`.
  - [ ] `part`.
- [ ] Use SQL joins equivalent to the docs in
  `docs/session-indexing-notes.md`.
- [ ] Rehydrate ids from row columns because `message.data` and `part.data`
  omit ids.
- [ ] Filter archived sessions by default with `session.time_archived is null`.
- [ ] Treat `parent_id` as child/subagent metadata, not fork metadata.
- [ ] Preserve enough metadata for project/path/workspace boosts.
- [ ] Do not rely only on `session.time_updated` for incremental correctness;
  message and part rows can change independently.

## Phase 4: Text Extraction

- [ ] Implement `extractSearchDocuments(session, message, part)`.
- [ ] Index `text` parts unless `ignored` is true.
- [ ] Skip `reasoning` parts initially.
- [ ] Index `tool` parts conservatively:
  - [ ] tool name.
  - [ ] completed title.
  - [ ] completed output, capped and chunked.
  - [ ] error text.
- [ ] Index `file` parts:
  - [ ] filename.
  - [ ] URL.
  - [ ] MIME type.
  - [ ] source path/name/URI when present.
- [ ] Index `patch` file lists and summaries if available.
- [ ] Index `subtask` prompt and description.
- [ ] Ignore step marker parts unless later ranking evidence says otherwise.
- [ ] Include context in indexed text:
  - [ ] title.
  - [ ] role.
  - [ ] path/directory.
  - [ ] part text.
- [ ] Chunk large synthetic text and tool output by token-ish character budget.
- [ ] Cap per-session indexed text to avoid one huge session dominating search.

## Phase 5: Embedding Client

- [ ] Implement a `llama.cpp` embedding client against `/v1/embeddings`.
- [ ] Send query strings with `search_query: `.
- [ ] Send document strings with `search_document: `.
- [ ] Batch document embeddings with a configurable batch size.
- [ ] Validate returned vector dimensions before inserting.
- [ ] Store embeddings as `Float32Array` buffers for `sqlite-vec`.
- [ ] Add retry/backoff for transient server failures.
- [ ] Fail gracefully into FTS-only mode when the server is unreachable.
- [ ] Add a health check command that reports:
  - [ ] server reachable.
  - [ ] model name if exposed.
  - [ ] returned dimensions.
  - [ ] vector table dimensions.

## Phase 6: Indexing Strategy

- [ ] Implement a full rebuild command:
  - [ ] clear sidecar docs.
  - [ ] scan source sessions/messages/parts.
  - [ ] extract documents.
  - [ ] populate FTS rows.
  - [ ] embed and populate vector rows when enabled.
- [ ] Implement incremental reconciliation:
  - [ ] scan recently changed sessions.
  - [ ] scan recently changed messages and parts.
  - [ ] rebuild affected sessions at session granularity.
  - [ ] periodically reconcile deletes and archived sessions.
- [ ] Track per-session source hash over session metadata plus extracted docs.
- [ ] Skip embedding when the source hash is unchanged.
- [ ] Rebuild a session transactionally in the sidecar.
- [ ] Keep a `last_full_reconcile` timestamp.
- [ ] Trigger background indexing on picker open if the index is stale.
- [ ] Add a manual dev command for rebuild/debug.

## Phase 7: Hybrid Query And Ranking

- [ ] Implement FTS query:
  - [ ] sanitize user input for FTS5.
  - [ ] search title/path/role/part_type/text.
  - [ ] return `bm25(document_fts)` plus row ids.
- [ ] Implement vector query:
  - [ ] embed query.
  - [ ] run `sqlite-vec` nearest-neighbor search.
  - [ ] return row ids plus distances.
- [ ] Implement RRF:
  - [ ] combine FTS rank and vector rank with `k = 60`.
  - [ ] keep separate diagnostic fields for debugging.
- [ ] Group document hits by `session_id`.
- [ ] Apply session-level boosts:
  - [ ] exact or fuzzy title match.
  - [ ] recency.
  - [ ] current project.
  - [ ] current path/workspace.
  - [ ] root sessions.
- [ ] Return root sessions by default.
- [ ] If a child session strongly matches, show parent relationship metadata.
- [ ] Include best matching snippet/title in internal result metadata.

## Phase 8: TUI Integration

- [ ] Replace current `searchSessions` in `src/tui.tsx`.
- [ ] Keep command registration unchanged:
  - [ ] `value: "session.list"`.
  - [ ] `keybind: "session_list"`.
- [ ] Keep navigation through OpenCode API:
  - [ ] `api.route.navigate("session", { sessionID })`.
- [ ] Keep mutation through OpenCode API:
  - [ ] rename through `api.client.session.update`.
  - [ ] delete through `api.client.session.delete`.
  - [ ] refresh metadata through `api.client.session.list`.
- [ ] Show indexing states:
  - [ ] searching.
  - [ ] indexing.
  - [ ] vector disabled.
  - [ ] source DB unavailable.
  - [ ] embedding server unavailable.
- [ ] Preserve built-in picker ergonomics:
  - [ ] debounce search.
  - [ ] root session filtering.
  - [ ] date categories.
  - [ ] current session marker if plugin API supports it.

## Phase 9: Dev Launcher Support

- [ ] Update `scripts/dev-opencode.ts` to set disposable search env vars.
- [ ] Keep all disposable state under `.opencode-dev/`.
- [ ] Do not remove XDG/config isolation.
- [ ] Add optional env passthrough for local llama.cpp server URL.
- [ ] Add README instructions for:
  - [ ] building/running `llama.cpp`.
  - [ ] downloading `nomic-embed-text-v1.5-GGUF`.
  - [ ] starting `llama-server`.
  - [ ] running `bun run dev:opencode -- <workspace>`.

## Phase 10: Tests And Verification

- [ ] Add unit tests for text extraction.
- [ ] Add unit tests for FTS query sanitization.
- [ ] Add unit tests for RRF ranking.
- [ ] Add unit tests for session grouping and boosts.
- [ ] Add sidecar migration tests using a temp SQLite DB.
- [ ] Add source-reader tests using fixture DB rows.
- [ ] Add embedding client tests with a mocked `/v1/embeddings` endpoint.
- [ ] Add fallback tests for vector-disabled and server-unavailable paths.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun test`.
- [ ] Manually verify disposable OpenCode flow:
  - [ ] `bun install`.
  - [ ] `bun install --cwd upstream/opencode`.
  - [ ] start `llama-server`.
  - [ ] `bun run dev:opencode -- <workspace>`.
  - [ ] press `Ctrl-X`, then `L`.
  - [ ] confirm semantic hits rank above title-only hits.

## Phase 11: Quality Gates Before Shipping

- [ ] Search still works with no vector server.
- [ ] Search does not mutate `opencode.db`.
- [ ] Index rebuild can be safely repeated.
- [ ] Index handles deleted sessions and archived sessions.
- [ ] Index handles malformed or unknown part JSON without crashing.
- [ ] The picker remains usable while background indexing runs.
- [ ] Sidecar schema version changes trigger deterministic migration/rebuild.
- [ ] The docs explain privacy tradeoffs and local-only embedding behavior.

