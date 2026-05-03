# opencode-smart-session-picker

Prototype OpenCode TUI plugin that replaces the built-in session picker opened
with `Ctrl-X` then `L`.

It adds a smarter local search path for finding past OpenCode sessions while
leaving your OpenCode sessions, config, and navigation in OpenCode itself. The
local search index is disposable and can be rebuilt from OpenCode data.

## Features

- Replaces the normal OpenCode session picker shortcut: `Ctrl-X` then `L`.
- Searches session titles, paths, and indexed transcript snippets.
- Uses a local SQLite search index for fast keyword search.
- Can use `fzf` for fuzzy ranking when requested.
- Keeps working with OpenCode's normal session search if the local index is not
  ready yet.
- Shows non-blocking status rows when indexing or optional dependencies are not
  available.
- Includes an isolated dev launcher for trying the plugin without touching your
  real OpenCode config or state.

## Requirements

- Bun for installing dependencies and running checks.
- OpenCode with TUI plugin support.
- Optional: `fzf` for `fzf` search mode.
- Optional: `llama-server` and a local embedding model for vector-search
  experiments.

## Install

From this repo:

```bash
bun install
```

Add the plugin to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/helios/opencode-smart-session-picker"]
}
```

Restart `opencode`, then press `Ctrl-X` followed by `L`.

## Search Modes

The default mode is `hybrid`, which currently uses the local SQLite keyword
index and falls back to OpenCode session search when needed.

To use another mode for a run:

```bash
OPENCODE_SMART_PICKER_SEARCH_MODE=fzf opencode /path/to/workspace
```

Available modes:

- `hybrid`: default local search mode.
- `fzf`: ranks sessions with an installed `fzf` executable.

Useful environment variables:

```bash
OPENCODE_SMART_PICKER_SEARCH_MODE=hybrid # or fzf
OPENCODE_SMART_PICKER_HYBRID_ALPHA=0.5
OPENCODE_SMART_PICKER_SEARCH_DB=/path/to/opencode-search.db
OPENCODE_SMART_PICKER_SOURCE_DB=/path/to/opencode.db
OPENCODE_SMART_PICKER_FZF_BIN=/path/to/fzf
OPENCODE_SMART_PICKER_EMBED_BASE_URL=http://127.0.0.1:8081
OPENCODE_SMART_PICKER_EMBED_MODEL=nomic-embed-text-v1.5
OPENCODE_SMART_PICKER_DISABLE_VECTOR=1
```

`OPENCODE_SMART_PICKER_HYBRID_ALPHA` is a ranking weight between `0` and `1`.
Changing it does not rebuild the local index.

## fzf Mode

Install `fzf` through your package manager:

```bash
brew install fzf
```

Check that it works:

```bash
fzf --version
printf 'alpha\nbeta\n' | fzf --filter a
```

Then run OpenCode with:

```bash
OPENCODE_SMART_PICKER_SEARCH_MODE=fzf opencode /path/to/workspace
```

## Optional Local Embeddings

The picker does not require a local embedding server. For vector-search
experiments, use a local `llama-server` embedding endpoint.

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

Smoke test:

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"search_query: test","model":"nomic-embed-text-v1.5","encoding_format":"float"}'
```

## Disposable Testing

Use the dev launcher to test against upstream OpenCode without changing your
real OpenCode config, data, state, or cache:

```bash
bun install
bun install --cwd upstream/opencode
bun run dev:opencode -- <workspace>
```

Omit `<workspace>` to open OpenCode against this repo.

The dev launcher writes under `.opencode-dev/` and uses an isolated OpenCode
home. It intentionally will not show your real OpenCode sessions.

## Checks

```bash
bun run typecheck
bun run test
```

`bun run test` runs the repo check suite. `bunfig.toml` scopes bare Bun test
discovery away from the reference submodules in `upstream/`.
