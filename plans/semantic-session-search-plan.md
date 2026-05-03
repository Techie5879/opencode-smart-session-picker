# Semantic Session Search Plan

## Goal

Build an end-to-end semantic OpenCode session picker that treats OpenCode as
the single source of truth, keeps OpenCode storage read-only, and stores only a
derived sidecar search index owned by this plugin.

The first implementation stays on the TUI plugin API path:

```text
OpenCode API and opencode.db
  source of truth for sessions, messages, parts, routing, mutation, and types

opencode-search.db
  derived sidecar index: version metadata, extracted documents, FTS5, sqlite-vec

llama.cpp
  optional local embedding server, OpenAI-compatible /v1/embeddings

TUI plugin
  reads OpenCode API for picker metadata, queries sidecar for ranking, navigates
  through OpenCode API
```

## Design Principles

- Derive the minimum possible state. The sidecar may cache only data needed for
  search and ranking. OpenCode remains authoritative for session existence,
  title, timestamps, parent relationship, routing, rename, delete, archive, and
  any future mutation.
- Prefer OpenCode types and APIs. Any OpenCode-owned domain object used in code
  must use a type imported directly from OpenCode packages when one is
  available. Do not duplicate OpenCode session/message/part/config shapes.
- Define local types only for plugin-owned features: sidecar rows, extracted
  search documents, ranked search results, dependency health, and UI state.
- Keep sidecar data disposable. Every sidecar row must be rebuildable from
  OpenCode storage plus the configured embedding profile.
- Avoid writing into OpenCode databases or global OpenCode config. The only
  first-run write should be this plugin's sidecar state or explicit user-chosen
  setup output.
- Keep dependencies optional where possible. FTS-only search must work when the
  vector extension, model file, or embedding server is unavailable.
- Do not introduce broad global caps or magic max constants. If a limit becomes
  necessary for correctness, keep it local to the extractor/indexer, document
  why it exists, and include it in versioned extractor metadata so rebuilds are
  deterministic.

## Reference Submodules

- [x] Add `upstream/sqlite-vec` for local vector search reference code.
- [x] Add `upstream/llama.cpp` for local embedding server reference code.
- [ ] Keep model-weight repositories out of git submodules.
- [ ] Document recommended external model download in README only; do not commit
  GGUF files.

## Embedding Profile

The initial recommended profile is local-only and optional:

- Runtime: `llama.cpp` `llama-server`.
- Base URL: `http://127.0.0.1:8081`.
- Embeddings endpoint: `/v1/embeddings`.
- Model family: `nomic-embed-text-v1.5-GGUF`.
- Expected dimensions: derived from the first successful embedding response and
  stored in sidecar metadata. The planned `nomic` profile should validate `768`
  dimensions, but code should not rely on an unrelated global constant.
- Document prefix: `search_document: `.
- Query prefix: `search_query: `.
- Vector backend: `sqlite-vec` `vec0`.
- Lexical backend: SQLite FTS5.
- Fusion: reciprocal rank fusion over FTS and vector ranks.

Example embedding server:

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

## Fresh Install Behavior

- Plugin install only requires `bun install` and a TUI plugin entry.
- On first picker open, search should work through OpenCode's session API even
  if the sidecar has not been created.
- If no sidecar exists, create `opencode-search.db`, run idempotent migrations,
  record metadata, and begin an FTS-only index build in the background.
- If `sqlite-vec` can be loaded and the embedding server is healthy, add vector
  rows as part of the same derived index. If not, mark vector state as disabled
  or unavailable and keep FTS results live.
- Do not auto-download model weights during picker open. Model download is an
  explicit setup step documented in README and, later, a dedicated setup script.
- Show visible but non-blocking status rows for first-run indexing, stale index,
  source DB unavailable, vector disabled, and embedding server unavailable.

## Existing Install And Upgrade Behavior

- Read `index_meta` before using the sidecar.
- If the sidecar schema version is older, run deterministic migrations when
  possible. If migration is not possible, rebuild the derived sidecar from
  OpenCode source data.
- If OpenCode source fingerprint changes, reconcile rather than trusting stale
  rows.
- If embedding profile changes, keep FTS rows when valid and rebuild only vector
  rows that depend on the old profile.
- If extractor version changes, rebuild affected documents and vectors because
  source hashes are no longer comparable.
- If the plugin was already installed but no sidecar exists, treat it as a fresh
  sidecar install without touching OpenCode config.
- If the model/server is no longer available, degrade to FTS/API search and keep
  existing vector metadata marked stale instead of deleting user-visible search.

## Non-Goals

- Do not patch OpenCode core for the first implementation.
- Do not write search tables into OpenCode's database.
- Do not edit, read, or copy the user's real global OpenCode config during
  disposable plugin testing.
- Do not index live `message.part.delta` bus events as durable content.
- Do not submodule GGUF model artifacts.
- Do not maintain an independent copy of OpenCode session state beyond the
  sidecar projections needed for ranking.

## Phase 1: OpenCode Boundaries And Types

- [ ] Replace local duplicated OpenCode-facing types with exported SDK/plugin
  types wherever available:
  - [x] Use OpenCode's exported `Session` type in `src/tui.tsx`.
  - [ ] Use OpenCode SDK/plugin message and part types in extractor boundaries
    where the public types are available.
  - [ ] Keep local types only for sidecar rows, search results, and extractor
    outputs.
- [ ] Add a type-boundary check during review for every new local type:
  - [ ] If it describes OpenCode-owned data, import the OpenCode type instead.
  - [ ] If it describes plugin-owned derived data, keep it minimal and include
    only fields the feature actually uses.
- [ ] Keep command registration unchanged:
  - [ ] `value: "session.list"`.
  - [ ] `keybind: "session_list"`.
- [ ] Keep navigation and mutation through OpenCode API:
  - [ ] `api.route.navigate("session", { sessionID })`.
  - [ ] rename through `api.client.session.update`.
  - [ ] delete through `api.client.session.delete`.
  - [ ] refresh display metadata through `api.client.session.list`.
- [ ] Use OpenCode API results as final display truth. Sidecar ranking may
  produce candidate session IDs, but the picker should hydrate visible title,
  timestamps, and parent/current status from OpenCode API before rendering.

## Phase 2: Configuration And Path Resolution

- [ ] Define minimal search configuration in `src/`, with environment overrides:
  - [ ] `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [ ] `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [ ] `OPENCODE_SMART_PICKER_EMBED_BASE_URL`.
  - [ ] `OPENCODE_SMART_PICKER_EMBED_MODEL`.
  - [ ] `OPENCODE_SMART_PICKER_DISABLE_VECTOR`.
- [ ] Resolve the source OpenCode database path:
  - [ ] Prefer explicit `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [ ] Then honor an OpenCode-provided DB path if one exists in the running
    environment.
  - [ ] In disposable dev, use the isolated `.opencode-dev` data path.
  - [ ] In tests, use fixture DB paths only. Do not guess the user's global DB.
- [ ] Resolve the sidecar search database path:
  - [ ] Prefer explicit `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [ ] Default next to the source DB as `opencode-search.db`.
  - [ ] In disposable dev, keep it under `.opencode-dev/`.
- [ ] Do not read or copy global OpenCode config to discover sessions. OpenCode
  API and explicit source DB paths are the only discovery sources.

## Phase 3: Dependency Checks

- [ ] Add a lightweight dependency health module that reports:
  - [ ] Bun runtime available for repo scripts.
  - [ ] sidecar SQLite can open.
  - [ ] FTS5 is available.
  - [ ] `sqlite-vec` extension can be loaded for the sidecar connection.
  - [ ] embedding base URL responds to `/health` or `/v1/health`.
  - [ ] `/v1/embeddings` returns a float embedding for a prefixed smoke-test
    query.
  - [ ] returned embedding dimensions match sidecar vector metadata when the
    vector table already exists.
- [ ] Make dependency health non-blocking for the picker:
  - [ ] no sidecar: use OpenCode API search while creating FTS index.
  - [ ] no `sqlite-vec`: FTS-only mode.
  - [ ] no embedding server: FTS-only mode.
  - [ ] dimension mismatch: disable vector and mark vector rebuild needed.
- [ ] Add README instructions for the minimum checks users can run manually:
  - [ ] `bun install`.
  - [ ] `bun run typecheck`.
  - [ ] `llama-server --help`.
  - [ ] `curl http://127.0.0.1:8081/health`.
  - [ ] `curl http://127.0.0.1:8081/v1/embeddings` smoke test.

## Phase 4: Sidecar Schema And Versioning

- [ ] Add a module that opens `opencode-search.db` with `bun:sqlite`.
- [ ] Load `sqlite-vec` only for the sidecar connection.
- [ ] Create idempotent migrations for:
  - [ ] `index_meta(key text primary key, value text not null)`.
  - [ ] `source_state(source_db_fingerprint text not null, last_full_reconcile integer, checked_at integer not null)`.
  - [ ] `indexed_session(session_id text primary key, parent_id text, project_id text, workspace_id text, directory text, path text, source_hash text not null, indexed_at integer not null)`.
  - [ ] `document(rowid integer primary key, doc_id text unique not null, session_id text not null, message_id text, part_id text, chunk_index integer not null, role text, part_type text, synthetic integer not null, ignored integer not null, text text not null, metadata_json text not null, source_hash text not null, extractor_version text not null, indexed_at integer not null)`.
  - [ ] `document_fts using fts5(title, directory, path, role, part_type, text, content='document', content_rowid='rowid')`.
  - [ ] vector table created only after embedding dimensions are known:
    `document_vec using vec0(embedding float[N])`.
- [ ] Store version/profile metadata in `index_meta`:
  - [ ] `schema_version`.
  - [ ] `extractor_version`.
  - [ ] `opencode_sdk_version` or package version when available.
  - [ ] `source_fingerprint`.
  - [ ] `embedding_provider`.
  - [ ] `embedding_base_url`.
  - [ ] `embedding_model`.
  - [ ] `embedding_dimensions`.
  - [ ] `document_prefix`.
  - [ ] `query_prefix`.
  - [ ] `vector_state`: `enabled`, `disabled`, `unavailable`, or `stale`.
- [ ] Add delete/rebuild paths that keep `document`, `document_fts`, and
  `document_vec` in sync in a transaction.
- [ ] Never treat sidecar metadata as authoritative for OpenCode display fields;
  it exists to support derived search ranking and invalidation.

## Phase 5: Source DB Reader

- [ ] Open the OpenCode database in read-only mode.
- [ ] Read only current projected tables:
  - [ ] `session`.
  - [ ] `message`.
  - [ ] `part`.
- [ ] Use SQL joins equivalent to `docs/session-indexing-notes.md`.
- [ ] Rehydrate IDs from row columns because JSON payloads may omit IDs.
- [ ] Filter archived sessions by default with OpenCode's archived timestamp
  semantics.
- [ ] Treat `parent_id` as child/subagent metadata, not fork metadata.
- [ ] Preserve only metadata needed for search grouping and boosts:
  - [ ] session ID.
  - [ ] parent ID.
  - [ ] project/workspace IDs.
  - [ ] directory/path.
  - [ ] source hashes.
- [ ] Do not rely only on `session.time_updated` for incremental correctness;
  message and part rows can change independently.

## Phase 6: Text Extraction

- [ ] Implement `extractSearchDocuments(session, message, part)` at the boundary
  between OpenCode source data and sidecar rows.
- [ ] Keep extractor output small and purposeful:
  - [ ] one or more `SearchDocument` rows.
  - [ ] source IDs.
  - [ ] role/type metadata.
  - [ ] plain searchable text.
  - [ ] metadata JSON for diagnostics only.
- [ ] Index `text` parts unless OpenCode marks them ignored.
- [ ] Skip `reasoning` parts initially.
- [ ] Index `tool` parts conservatively:
  - [ ] tool name.
  - [ ] completed title.
  - [ ] completed output/error text when present.
- [ ] Index `file` parts:
  - [ ] filename.
  - [ ] URL.
  - [ ] MIME type.
  - [ ] source path/name/URI when present.
- [ ] Index `patch` file lists and summaries if available.
- [ ] Index `subtask` prompt and description.
- [ ] Ignore step marker parts unless ranking evidence later shows value.
- [ ] Include context in indexed text only when it improves retrieval:
  - [ ] title from OpenCode.
  - [ ] role.
  - [ ] path/directory.
  - [ ] part text.
- [ ] If chunking is needed, make it part of `extractor_version` so old rows are
  invalidated deterministically.

## Phase 7: Embedding Client

- [ ] Implement a `llama.cpp` embedding client against `/v1/embeddings`.
- [ ] Send query strings with the configured query prefix.
- [ ] Send document strings with the configured document prefix.
- [ ] Batch only where the server accepts array input; preserve input order and
  returned indexes.
- [ ] Validate returned data:
  - [ ] response contains one embedding per input.
  - [ ] every value is a finite number.
  - [ ] dimensions are consistent with the sidecar vector table.
- [ ] Store embeddings as `Float32Array` buffers for `sqlite-vec`.
- [ ] Add retry/backoff for transient server failures.
- [ ] Fail gracefully into FTS-only mode when the server is unreachable.
- [ ] Add a health check command that reports:
  - [ ] server reachable.
  - [ ] model name if exposed.
  - [ ] returned dimensions.
  - [ ] vector state and rebuild requirement.

## Phase 8: Indexing Strategy

- [ ] Implement a full rebuild command:
  - [ ] clear sidecar derived documents.
  - [ ] scan source sessions/messages/parts.
  - [ ] extract documents.
  - [ ] populate FTS rows.
  - [ ] embed and populate vector rows when enabled.
- [ ] Implement incremental reconciliation:
  - [ ] scan changed sessions, messages, and parts.
  - [ ] rebuild affected sessions at session granularity.
  - [ ] periodically reconcile deletes and archived sessions.
- [ ] Track per-session source hash over session metadata plus extracted docs.
- [ ] Skip unchanged sidecar rows when the source hash and extractor version
  match.
- [ ] Rebuild a session transactionally in the sidecar.
- [ ] Keep `last_full_reconcile` in `source_state`.
- [ ] Trigger background indexing on picker open if the index is missing or
  stale.
- [ ] Add a manual dev command for rebuild/debug.

## Phase 9: Hybrid Query And Ranking

- [ ] Implement FTS query:
  - [ ] sanitize user input for FTS5.
  - [ ] search title/directory/path/role/part_type/text.
  - [ ] return `bm25(document_fts)` plus row IDs.
- [ ] Implement vector query:
  - [ ] embed query.
  - [ ] run `sqlite-vec` nearest-neighbor search.
  - [ ] return row IDs plus distances.
- [ ] Implement rank fusion:
  - [ ] combine FTS and vector ranks.
  - [ ] keep separate diagnostic fields for debugging.
  - [ ] keep fusion parameters local to the ranking module and covered by tests.
- [ ] Group document hits by `session_id`.
- [ ] Apply session-level boosts only from OpenCode-derived metadata:
  - [ ] exact/fuzzy title match.
  - [ ] recency.
  - [ ] current project.
  - [ ] current path/workspace.
  - [ ] root sessions.
- [ ] Return root sessions by default.
- [ ] If a child session strongly matches, show parent relationship metadata
  without changing OpenCode's underlying relationship semantics.
- [ ] Include best matching snippet/title in internal result metadata.

## Phase 10: TUI Integration

- [ ] Replace current `searchSessions` in `src/tui.tsx` with a two-stage flow:
  - [ ] query sidecar for ranked candidate IDs when available.
  - [ ] hydrate final visible rows from OpenCode API.
  - [ ] fall back to OpenCode API search when sidecar is missing/unusable.
- [ ] Show states:
  - [ ] searching.
  - [ ] indexing.
  - [ ] vector disabled.
  - [ ] source DB unavailable.
  - [ ] embedding server unavailable.
  - [ ] sidecar stale/rebuilding.
- [ ] Preserve built-in picker ergonomics:
  - [ ] debounce search.
  - [ ] root session filtering.
  - [ ] date categories.
  - [ ] current session marker if plugin API supports it.

## Phase 11: Dev Launcher Support

- [ ] Update `scripts/dev-opencode.ts` to set disposable search env vars.
- [ ] Keep all disposable state under `.opencode-dev/`.
- [ ] Do not remove XDG/config isolation.
- [ ] Add optional env passthrough for local llama.cpp server URL.
- [ ] Add README instructions for:
  - [ ] building/running `llama.cpp`.
  - [ ] downloading `nomic-embed-text-v1.5-GGUF`.
  - [ ] starting `llama-server`.
  - [ ] running `bun run dev:opencode -- <workspace>`.

## Phase 12: Tests And Verification

- [ ] Add unit tests for text extraction.
- [ ] Add unit tests for FTS query sanitization.
- [ ] Add unit tests for rank fusion.
- [ ] Add unit tests for session grouping and boosts.
- [ ] Add sidecar migration tests using a temp SQLite DB.
- [ ] Add source-reader tests using fixture DB rows.
- [ ] Add embedding client tests with a mocked `/v1/embeddings` endpoint.
- [ ] Add fallback tests for vector-disabled and server-unavailable paths.
- [ ] Add fresh-install tests:
  - [ ] no sidecar.
  - [ ] no vector extension.
  - [ ] no embedding server.
- [ ] Add existing-install tests:
  - [ ] current schema.
  - [ ] older schema migration.
  - [ ] extractor version change.
  - [ ] embedding dimension/profile change.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run test`.
- [ ] Manually verify disposable OpenCode flow:
  - [ ] `bun install`.
  - [ ] `bun install --cwd upstream/opencode`.
  - [ ] start `llama-server`.
  - [ ] `bun run dev:opencode -- <workspace>`.
  - [ ] press `Ctrl-X`, then `L`.
  - [ ] confirm semantic hits rank above title-only hits.

## Phase 13: Quality Gates Before Shipping

- [ ] Search still works with no vector server.
- [ ] Search still works with no sidecar by falling back to OpenCode API.
- [ ] Search does not mutate `opencode.db`.
- [ ] Index rebuild can be safely repeated.
- [ ] Index handles deleted sessions and archived sessions.
- [ ] Index handles malformed or unknown part JSON without crashing.
- [ ] The picker remains usable while background indexing runs.
- [ ] Sidecar schema version changes trigger deterministic migration/rebuild.
- [ ] OpenCode API remains the final display/mutation source of truth.
- [ ] The docs explain privacy tradeoffs and local-only embedding behavior.
