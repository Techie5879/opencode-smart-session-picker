# Vector Sidecar Runtime

## Boundary

The smart session picker must not mutate OpenCode's native database. OpenCode
session data remains the source of truth and is read through OpenCode APIs or
read-only database inspection in tests/research helpers.

Vector search is plugin-owned sidecar state. The sidecar database is separate
from OpenCode's database:

- OpenCode DB: source session/message/part data.
- Smart picker sidecar DB: FTS rows, extracted documents, vector metadata, and
  optional `sqlite-vec` tables.

Deleting the sidecar must only force reindexing. It must not delete or modify
OpenCode sessions.

## SQLite Runtime Constraint

`sqlite-vec` is a loadable SQLite extension. Bun's default macOS SQLite build
can reject extension loading with:

```text
This build of sqlite3 does not support dynamic extension loading
```

Bun exposes `Database.setCustomSQLite(path)` to use an extension-capable SQLite
library. The plugin auto-detects common Homebrew SQLite library paths on macOS,
or accepts `OPENCODE_SMART_PICKER_SQLITE_LIB` as an override. That setting is
process-wide and must happen before the first `bun:sqlite` database is opened.
It does not change the OpenCode database file, path, schema, or rows, but it can
affect which SQLite library later `bun:sqlite` connections use inside the same
OpenCode TUI process.

Because this is process-wide, vector support must stay scoped as a sidecar
feature. If enabled in-process, verify that OpenCode's source DB is unchanged
before and after sidecar vector operations. A stricter future implementation can
move `sqlite-vec` work into a child process so the custom SQLite library cannot
affect the OpenCode process at all.

## Debug Verification

Use the disposable dev state so no real OpenCode state is touched:

```bash
SOURCE_DB=.opencode-dev/xdg/data/opencode/opencode-local.db
SEARCH_DB=.opencode-dev/opencode-search.db
stat -f "%z %m %N" "$SOURCE_DB"

XDG_DATA_HOME="$PWD/.opencode-dev/xdg/data" \
OPENCODE_CHANNEL=local \
OPENCODE_SMART_PICKER_SEARCH_DB="$PWD/$SEARCH_DB" \
OPENCODE_SMART_PICKER_EMBED_BASE_URL=http://127.0.0.1:8081 \
bun -e 'import("./src/search/status.ts").then(async ({ checkSearchEnvironment }) => {
  const status = await checkSearchEnvironment({ mode: "hybrid" })
  console.log(status.modeDependencies.hybrid)
})'

stat -f "%z %m %N" "$SOURCE_DB"
```

Expected result:

- `sqlite-vec` reports `available`.
- `llama-server` reports `available` if the embedding server is running.
- The before/after OpenCode source DB size and mtime are unchanged.
