# Semantic Session Search Plan

## Goal

Build an end-to-end semantic OpenCode session picker that treats OpenCode as
the single source of truth, keeps OpenCode storage read-only, and stores only a
derived sidecar search index owned by this plugin.

Current implementation status:

- [x] Upstream reconnaissance is documented in
  `docs/upstream-search-implementation-notes.md`.
- [x] The TUI override remains limited to command `session.list` through
  `api.keymap.registerLayer`.
- [x] Search code lives in `src/search/` as sidecar/plugin-owned behavior.
- [x] OpenCode-owned TUI/session/message/part types are imported from public
  OpenCode packages.
- [x] Fresh sidecar creation, schema migration, FTS indexing,
  hybrid keyword ranking, fzf mode, llama-compatible embedding client, and
  integration tests are implemented.
- [x] sqlite-vec vector row creation/query is wired as optional behavior gated
  on an installed/loadable sqlite-vec extension and live embedding server.
- [x] Disposable TUI smoke test verifies the plugin-owned `Smart Sessions`
  dialog opens through `Ctrl-X` then `l`.
- [ ] Manual full semantic/vector verification with a live `llama-server` still requires a
  local model/server.

The first implementation stays on the TUI plugin API path:

```text
OpenCode API and opencode.db
  source of truth for sessions, messages, parts, routing, mutation, and types

opencode-search.db
  derived sidecar index: version metadata, extracted documents, FTS5, sqlite-vec

llama.cpp
  optional local embedding server, OpenAI-compatible /v1/embeddings

TUI plugin
  reads OpenCode API for picker metadata, runs the selected search mode,
  hydrates final display rows through OpenCode API, navigates through OpenCode
  API
```

## Design Principles

- Derive the minimum possible state. The sidecar may cache only data needed for
  search and ranking. OpenCode remains authoritative for session existence,
  title, timestamps, parent relationship, routing, rename, delete, archive, and
  any future mutation.
- Prefer OpenCode types and APIs. Any OpenCode-owned domain object used in code
  must use a type imported directly from OpenCode packages when one is
  available. Do not duplicate OpenCode session/message/part/config shapes.
- Before adding local behavior, inspect native upstream surfaces first:
  OpenCode for session APIs/types/commands/dialog contracts, OpenTUI for public
  TUI primitives, fzf for fuzzy scoring/filter behavior, sqlite-vec for vector
  storage/query behavior, llama.cpp for embedding server behavior, and Bun or
  SQLite for filesystem/database primitives. Use focused subagents in parallel
  for this reconnaissance when the implementation task is broad enough and their
  work can stay read-only and non-conflicting.
- Define local types only for plugin-owned features: sidecar rows, extracted
  search documents, ranked search results, dependency health, and UI state.
- Keep search mode abstractions plugin-owned and minimal. The mode selector may
  choose between hybrid search and fzf search, but both modes must return
  candidate session IDs that are hydrated by OpenCode before rendering.
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
- [x] Add `upstream/fzf` for fuzzy finder reference code and CLI behavior.
- [x] Keep model-weight repositories out of git submodules.
- [x] Document recommended external model download in README only; do not commit
  GGUF files.

## Search Modes

The picker supports two search modes behind one command path:

- `hybrid`: default semantic search mode. It combines keyword evidence from
  SQLite FTS5 and vector evidence from sqlite-vec. The query-time `alpha` value
  controls the tradeoff: `0` means keyword-only weighting, `1` means
  vector-only weighting, and values between them blend normalized keyword and
  vector scores. `alpha` is runtime ranking configuration, not schema
  configuration, so changing it must not require a sidecar rebuild.
- `fzf`: fuzzy search mode. It uses fzf-native filtering/scoring semantics over
  OpenCode-hydrated session display fields and, when the sidecar exists,
  derived document snippets. It must call an installed `fzf` binary or reuse a
  directly exposed fzf-native scoring implementation if one becomes available;
  do not hand-roll an independent fuzzy matcher unless upstream inspection proves
  there is no usable native path.

Both modes must keep OpenCode as the display and routing source of truth:

- Candidate IDs may come from OpenCode API search, the sidecar, fzf ranking, or
  hybrid ranking.
- Visible title, time, parent/current/root status, and route target must be
  hydrated from OpenCode API results immediately before rendering.
- Missing/stale sidecar rows must surface a clear mode-unavailable message to
  the user, not silently fall back to a different search backend.
- Missing `fzf` must disable only `fzf` mode and report it as unavailable.

Implementation placement:

- The command registration and picker surface stay thin.
- Search orchestration belongs in the plugin-owned search module.
- Hybrid retrieval belongs in the sidecar/ranking modules.
- fzf behavior belongs behind the fzf adapter.
- README should describe user-facing capabilities and setup only; type
  boundaries, module placement, rollout rules, and degradation contracts live in
  this plan and `AGENTS.md`.

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
- Hybrid scoring: normalized keyword score and normalized vector score blended
  by `alpha`.
- Fallback fusion: reciprocal rank fusion may be used only when comparable
  normalized scores are unavailable, and that choice must be local to the hybrid
  ranking module.

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
- If `fzf` is installed, mark fzf mode available after a non-interactive
  `--filter` smoke test. If `fzf` is missing, mark only fzf mode unavailable.
- Do not auto-download model weights during picker open. Model download is an
  explicit setup step documented in README and, later, a dedicated setup script.
- Show visible but non-blocking status rows for first-run indexing, stale index,
  source DB unavailable, vector disabled, embedding server unavailable, and fzf
  unavailable when fzf mode is selected.

## Existing Install And Upgrade Behavior

- Read `index_meta` before using the sidecar.
- If the sidecar schema version needs migration, run deterministic migrations when
  possible. If migration is not possible, rebuild the derived sidecar from
  OpenCode source data.
- If OpenCode source fingerprint changes, reconcile rather than trusting stale
  rows.
- If embedding profile changes, keep FTS rows when valid and rebuild only vector
  rows that depend on the superseded profile.
- If extractor version changes, rebuild affected documents and vectors because
  source hashes are no longer comparable.
- If the plugin was already installed but no sidecar exists, treat it as a fresh
  sidecar install without touching OpenCode config.
- If the model/server is no longer available, degrade to FTS/API search and keep
  existing vector metadata marked stale instead of deleting user-visible search.
- If the saved or requested search mode is unavailable, surface a clear
  mode-unavailable message in the picker status bar. Do not silently fall back
  to OpenCode API search or switch into a different mode.
- If `alpha` changes between runs, apply the new value immediately at query
  time. Do not rebuild the sidecar just because ranking weights changed.

## Non-Goals

- Do not patch OpenCode core for the first implementation.
- Do not write search tables into OpenCode's database.
- Do not edit, read, or copy the user's real global OpenCode config during
  disposable plugin testing.
- Do not index live `message.part.delta` bus events as durable content.
- Do not submodule GGUF model artifacts.
- Do not maintain an independent copy of OpenCode session state beyond the
  sidecar projections needed for ranking.
- Do not invoke fzf as an interactive full-screen UI inside the OpenCode TUI.
  The plugin owns the dialog surface and may use fzf only as a non-interactive
  ranking/filtering dependency unless the user explicitly asks for a different
  UI.
- Do not add a second command path for fzf mode. Mode selection lives behind the
  existing `session.list` override.

## Phase 1: OpenCode Boundaries And Types

- [x] Before each implementation phase, inspect upstream surfaces first:
  - [x] OpenCode exported SDK/plugin types and TUI command/dialog behavior.
  - [x] OpenTUI public components/events before creating UI primitives.
  - [x] fzf CLI/library behavior before creating fuzzy ranking code.
  - [x] sqlite-vec docs/examples before creating vector queries.
  - [x] llama.cpp server docs/examples before creating embedding setup or health
    checks.
  - [x] Bun/SQLite/filesystem APIs before adding third-party dependencies.
- [x] Use parallel read-only subagents for upstream inspection when the phase has
  independent questions that can be answered without blocking local work.
- [x] Replace local duplicated OpenCode-facing types with exported SDK/plugin
  types wherever available:
  - [x] Use OpenCode's exported `Session` type in `src/tui.tsx`.
  - [x] Use OpenCode SDK/plugin message and part types in extractor boundaries
    where the public types are available.
  - [x] Keep local types only for sidecar rows, search results, and extractor
    outputs.
- [x] Add a type-boundary check during review for every new local type:
  - [x] If it describes OpenCode-owned data, import the OpenCode type instead.
  - [x] If it describes plugin-owned derived data, keep it minimal and include
    only fields the feature actually uses.
- [x] Keep command registration limited to:
  - [x] `api.keymap.registerLayer`.
  - [x] command name `session.list`.
- [x] Keep navigation and mutation through OpenCode API:
  - [x] `api.route.navigate("session", { sessionID })`.
  - [ ] rename through `api.client.session.update`.
  - [ ] delete through `api.client.session.delete`.
  - [x] refresh display metadata through `api.client.session.list`.
- [x] Use OpenCode API results as final display truth. Sidecar ranking may
  produce candidate session IDs, but the picker should hydrate visible title,
  timestamps, and parent/current status from OpenCode API before rendering.

## Phase 2: Configuration And Path Resolution

- [x] Define minimal search configuration in `src/`, with environment overrides:
  - [x] `OPENCODE_SMART_PICKER_SEARCH_MODE`: `hybrid` or `fzf`.
  - [x] `OPENCODE_SMART_PICKER_HYBRID_ALPHA`: query-time blend between keyword
    and vector scores.
  - [x] `OPENCODE_SMART_PICKER_FZF_BIN`: optional path to the `fzf` executable.
  - [x] `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [x] `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [x] `OPENCODE_SMART_PICKER_EMBED_BASE_URL`.
  - [x] `OPENCODE_SMART_PICKER_EMBED_MODEL`.
  - [x] `OPENCODE_SMART_PICKER_DISABLE_VECTOR`.
- [x] Resolve the source OpenCode database path:
  - [x] Prefer explicit `OPENCODE_SMART_PICKER_SOURCE_DB`.
  - [x] Then honor an OpenCode-provided DB path if one exists in the running
    environment.
  - [x] In disposable dev, use the isolated `.opencode-dev` data path.
  - [x] In tests, use fixture DB paths only. Do not guess the user's global DB.
- [x] Resolve the sidecar search database path:
  - [x] Prefer explicit `OPENCODE_SMART_PICKER_SEARCH_DB`.
  - [x] Default next to the source DB as `opencode-search.db`.
  - [x] In disposable dev, keep it under `.opencode-dev/`.
- [x] Resolve fzf dependency path:
  - [x] Prefer explicit `OPENCODE_SMART_PICKER_FZF_BIN`.
  - [x] Then search `PATH`.
  - [x] In dev, allow `upstream/fzf/bin/fzf` when it has been built locally.
  - [x] Do not download or build fzf automatically during picker open.
- [x] Validate `OPENCODE_SMART_PICKER_HYBRID_ALPHA` locally in the ranking
  module. Clamp or reject invalid values there; do not create an unrelated
  global constant.
- [x] Do not read or copy global OpenCode config to discover sessions. OpenCode
  API and explicit source DB paths are the only discovery sources.

## Phase 3: Dependency Checks

- [x] Add a lightweight dependency health module that reports:
  - [x] Bun runtime available for repo scripts.
  - [x] sidecar SQLite can open.
  - [x] FTS5 is available.
  - [ ] `sqlite-vec` extension can be loaded for the sidecar connection.
  - [x] embedding base URL responds to `/health` or `/v1/health`.
  - [x] `/v1/embeddings` returns a float embedding for a prefixed smoke-test
    query.
  - [ ] returned embedding dimensions match sidecar vector metadata when the
    vector table already exists.
  - [x] `fzf --version` succeeds when fzf mode is selected or configured.
  - [x] `printf 'alpha\nbeta\n' | fzf --filter a` returns deterministic output
    and exits successfully.
- [x] Make dependency health non-blocking for the picker:
  - [x] no sidecar: use OpenCode API search while creating FTS index.
  - [x] no `sqlite-vec`: FTS-only mode.
  - [x] no embedding server: FTS-only mode.
  - [ ] dimension mismatch: disable vector and mark vector rebuild needed.
  - [x] no `fzf`: disable fzf mode and show fzf-unavailable state only when the
    user selected fzf.
- [x] Add README instructions for the minimum checks users can run manually:
  - [x] `bun install`.
  - [x] `bun run typecheck`.
  - [x] `fzf --version`.
  - [x] `printf 'alpha\nbeta\n' | fzf --filter a`.
  - [x] `llama-server --help`.
  - [x] `curl http://127.0.0.1:8081/health`.
  - [x] `curl http://127.0.0.1:8081/v1/embeddings` smoke test.

## Phase 4: Sidecar Schema And Versioning

- [x] Add a module that opens `opencode-search.db` with `bun:sqlite`.
- [x] Load `sqlite-vec` only for the sidecar connection.
- [x] Create idempotent migrations for:
  - [x] `index_meta(key text primary key, value text not null)`.
  - [x] `source_state(source_db_fingerprint text not null, last_full_reconcile integer, checked_at integer not null)`.
  - [x] `indexed_session(session_id text primary key, parent_id text, project_id text, workspace_id text, directory text, path text, source_hash text not null, indexed_at integer not null)`.
  - [x] `document(rowid integer primary key, doc_id text unique not null, session_id text not null, message_id text, part_id text, chunk_index integer not null, role text, part_type, synthetic integer not null, ignored integer not null, title text, directory text, path text, text text not null, metadata_json text not null, source_hash text not null, extractor_version text not null, indexed_at integer not null)`.
  - [x] `document_fts using fts5(title, directory, path, role, part_type, text, content='document', content_rowid='rowid')`.
  - [x] vector table created only after embedding dimensions are known:
    `document_vec using vec0(embedding float[N])`.
- [x] Store version/profile metadata in `index_meta`:
  - [x] `schema_version`.
  - [x] `extractor_version`.
  - [ ] `opencode_sdk_version` or package version when available.
  - [ ] `source_fingerprint`.
  - [ ] `embedding_provider`.
  - [x] `embedding_base_url`.
  - [x] `embedding_model`.
  - [x] `embedding_dimensions`.
  - [x] `document_prefix`.
  - [x] `query_prefix`.
  - [x] `vector_state`: `enabled`, `disabled`, `unavailable`, or `stale`.
  - [x] `ranking_version`.
  - [x] `supported_search_modes`: expected to include `hybrid`; include `fzf`
    only when dependency checks have passed.
- [x] Add delete/rebuild paths that keep `document`, `document_fts`, and
  `document_vec` in sync in a transaction.
- [x] Never treat sidecar metadata as authoritative for OpenCode display fields;
  it exists to support derived search ranking and invalidation.

## Phase 5: Source DB Reader

- [x] Open the OpenCode database in read-only mode.
- [x] Read only current projected tables:
  - [x] `session`.
  - [x] `message`.
  - [x] `part`.
- [x] Use SQL joins equivalent to `docs/session-indexing-notes.md`.
- [x] Rehydrate IDs from row columns because JSON payloads may omit IDs.
- [x] Filter archived sessions by default with OpenCode's archived timestamp
  semantics.
- [x] Treat `parent_id` as child/subagent metadata, not fork metadata.
- [x] Preserve only metadata needed for search grouping and boosts:
  - [x] session ID.
  - [x] parent ID.
  - [x] project/workspace IDs.
  - [x] directory/path.
  - [x] source hashes.
- [ ] Do not rely only on `session.time_updated` for incremental correctness;
  message and part rows can change independently.

## Phase 6: Text Extraction

- [x] Implement `extractSearchDocuments(session, message, part)` at the boundary
  between OpenCode source data and sidecar rows.
- [x] Keep extractor output small and purposeful:
  - [x] one or more `SearchDocument` rows.
  - [x] source IDs.
  - [x] role/type metadata.
  - [x] plain searchable text.
  - [x] metadata JSON for diagnostics only.
- [x] Index `text` parts unless OpenCode marks them ignored.
- [x] Skip `reasoning` parts initially.
- [x] Index `tool` parts conservatively:
  - [x] tool name.
  - [x] completed title.
  - [x] completed output/error text when present.
- [x] Index `file` parts:
  - [x] filename.
  - [x] URL.
  - [x] MIME type.
  - [x] source path/name/URI when present.
- [x] Index `patch` file lists and summaries if available.
- [x] Index `subtask` prompt and description.
- [x] Ignore step marker parts unless ranking evidence later shows value.
- [x] Include context in indexed text only when it improves retrieval:
  - [x] title from OpenCode.
  - [x] role.
  - [x] path/directory.
  - [x] part text.
- [ ] If chunking is needed, make it part of `extractor_version` so stale rows are
  invalidated deterministically.

## Phase 7: Embedding Client

- [x] Implement a `llama.cpp` embedding client against `/v1/embeddings`.
- [x] Send query strings with the configured query prefix.
- [x] Send document strings with the configured document prefix.
- [ ] Batch only where the server accepts array input; preserve input order and
  returned indexes.
- [x] Validate returned data:
  - [x] response contains one embedding per input.
  - [x] every value is a finite number.
  - [ ] dimensions are consistent with the sidecar vector table.
- [x] Store embeddings as `Float32Array` buffers for `sqlite-vec`.
- [ ] Add retry/backoff for transient server failures.
- [x] Fail gracefully into FTS-only mode when the server is unreachable.
- [ ] Add a health check command that reports:
  - [ ] server reachable.
  - [ ] model name if exposed.
  - [ ] returned dimensions.
  - [ ] vector state and rebuild requirement.

## Phase 8: Indexing Strategy

- [x] Implement a full rebuild command:
  - [x] clear sidecar derived documents.
  - [x] scan source sessions/messages/parts.
  - [x] extract documents.
  - [x] populate FTS rows.
  - [x] embed and populate vector rows when enabled.
- [ ] Implement incremental reconciliation:
  - [ ] scan changed sessions, messages, and parts.
  - [ ] rebuild affected sessions at session granularity.
  - [ ] periodically reconcile deletes and archived sessions.
- [ ] Track per-session source hash over session metadata plus extracted docs.
- [ ] Skip unchanged sidecar rows when the source hash and extractor version
  match.
- [x] Rebuild a session transactionally in the sidecar.
- [ ] Keep `last_full_reconcile` in `source_state`.
- [x] Trigger background indexing on picker open if the index is missing or
  stale.
- [ ] Add a manual dev command for rebuild/debug.

## Phase 9: Search Modes And Ranking

- [x] Define a minimal plugin-owned search mode boundary:
  - [x] input: OpenCode API session candidates, query string, sidecar handle,
    dependency health, and runtime mode config.
  - [x] output: ordered candidate session IDs plus plugin-owned diagnostics.
  - [x] no OpenCode-owned local session/message/part types.
- [x] Implement hybrid FTS query:
  - [x] sanitize user input for FTS5.
  - [x] search title/directory/path/role/part_type/text.
  - [x] return keyword scores plus row IDs.
- [x] Implement hybrid vector query:
  - [x] embed query.
  - [x] run `sqlite-vec` nearest-neighbor search.
  - [x] return vector scores plus row IDs.
- [x] Implement hybrid alpha scoring:
  - [x] normalize keyword and vector scores onto compatible ranges.
  - [x] apply `score = (1 - alpha) * keyword + alpha * vector`.
  - [x] `alpha = 0` produces keyword-only ranking.
  - [x] `alpha = 1` produces vector-only ranking when vector is available.
  - [x] vector unavailable with `alpha > 0` degrades to keyword-only with a
    diagnostic state; it does not fail the picker.
  - [x] keep alpha parsing/defaulting local to the ranking module.
  - [x] keep separate diagnostic fields for debugging.
  - [x] keep ranking parameters local to the ranking module and covered by
    tests.
- [x] Implement fzf mode:
  - [x] collect candidate lines from OpenCode-hydrated session display metadata.
  - [x] append sidecar-derived snippets only when available and current.
  - [x] encode each candidate with a stable session ID delimiter that cannot be
    confused with display text.
  - [x] call `fzf --filter <query>` non-interactively through the resolved fzf
    binary.
  - [x] parse fzf output back to session IDs.
  - [x] preserve fzf result order.
  - [x] if fzf exits with no matches, return no matches rather than falling back
    to a different mode for that query.
   - [x] if fzf is missing/unhealthy, report mode unavailable and surface the
     error to the user without falling back to a different search backend.
- [x] Group document hits by `session_id`.
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

- [x] Replace current `searchSessions` in `src/tui.tsx` with a two-stage flow:
  - [x] resolve the active search mode.
  - [x] query hybrid or fzf mode for ranked candidate IDs when available.
  - [x] hydrate final visible rows from OpenCode API.
   - [x] surface mode-unavailable message when sidecar is missing/unusable.
- [x] Keep mode selection behind the existing `session.list` picker:
  - [x] no new command palette entry.
  - [x] no new OpenCode route.
  - [x] no native OpenCode dialog override beyond the current picker dialog.
- [x] Add a minimal mode control using public plugin APIs and OpenTUI
  primitives:
  - [x] render `hybrid` and `fzf` as distinct status/control chips in the
    existing picker dialog.
  - [x] switch the current picker session without adding commands, routes, or
    native OpenCode overrides.
  - [x] disable fzf selection when the fzf executable/smoke test is not
    available.
  - [x] keep dependency state out of the selectable session list.
- [x] Show states:
  - [x] searching.
  - [x] indexing.
  - [x] vector disabled.
  - [x] source DB unavailable.
  - [x] embedding server unavailable.
  - [x] fzf unavailable.
  - [x] sqlite-vec unavailable.
  - [x] sidecar index available/empty/error.
  - [ ] sidecar stale/rebuilding.
- [ ] Preserve built-in picker ergonomics:
  - [ ] debounce search.
  - [ ] root session filtering.
  - [ ] date categories.
  - [ ] current session marker if plugin API supports it.

## Phase 11: Dev Launcher Support

- [x] Update `scripts/dev-opencode.ts` to set disposable search env vars.
- [x] Keep all disposable state under `.opencode-dev/`.
- [x] Do not remove XDG/config isolation.
- [x] Add optional env passthrough for local llama.cpp server URL.
- [x] Add optional env passthrough for `OPENCODE_SMART_PICKER_SEARCH_MODE`,
  `OPENCODE_SMART_PICKER_HYBRID_ALPHA`, and
  `OPENCODE_SMART_PICKER_FZF_BIN`.
- [x] Add README instructions for:
  - [x] installing or building `fzf`.
  - [x] building/running `llama.cpp`.
  - [x] downloading `nomic-embed-text-v1.5-GGUF`.
  - [x] starting `llama-server`.
  - [x] running `bun run dev:opencode -- <workspace>`.

## Phase 12: Tests And Verification

- [x] Add integration tests for text extraction through a real sidecar DB.
- [x] Add integration tests for FTS query behavior through real SQLite FTS5.
- [x] Add integration tests for hybrid alpha scoring:
   - [x] vector-unavailable degradation to keyword-only.
- [x] Add integration tests for fzf mode with a fake `fzf` executable.
- [x] Add sidecar migration tests using a temp SQLite DB.
- [x] Add source-reader tests using fixture DB rows.
- [x] Add embedding client tests with a real local `/v1/embeddings` HTTP server.
- [x] Add tests for vector-disabled paths.
- [x] Add fresh-install tests:
  - [x] no sidecar.
  - [x] no vector extension.
  - [ ] no embedding server.
- [ ] Add existing-install tests:
  - [ ] current schema.
  - [ ] schema migration.
  - [ ] extractor version change.
  - [ ] embedding dimension/profile change.
  - [ ] fzf missing after previously being available.
  - [ ] search mode changed between runs.
- [x] Run `bun run typecheck`.
- [x] Run `bun run test`.
- [ ] Manually verify disposable OpenCode flow:
  - [x] `bun install`.
  - [x] `bun install --cwd upstream/opencode`.
  - [x] `fzf --version`.
  - [ ] start `llama-server`.
  - [x] `bun run dev:opencode -- <workspace>`.
  - [x] press `Ctrl-X`, then `L`.
  - [ ] confirm semantic hits rank above title-only hits.
  - [ ] confirm fzf mode returns expected fuzzy matches when selected.

## Phase 13: Quality Gates Before Shipping

- [ ] Search still works with no vector server.
- [ ] Search still works with no fzf binary unless fzf mode is explicitly
  selected, and explicit fzf mode reports the missing dependency clearly.
- [ ] Search surfaces a clear mode-unavailable message when the sidecar is
  missing, without silently falling back to OpenCode API.
- [ ] Search does not mutate `opencode.db`.
- [ ] Index rebuild can be safely repeated.
- [ ] Index handles deleted sessions and archived sessions.
- [ ] Index handles malformed or unknown part JSON without crashing.
- [ ] The picker remains usable while background indexing runs.
- [ ] Sidecar schema version changes trigger deterministic migration/rebuild.
- [ ] OpenCode API remains the final display/mutation source of truth.
- [ ] The docs explain privacy tradeoffs and local-only embedding behavior.
- [ ] The docs explain the two search modes, alpha behavior, and fzf dependency
  checks.
