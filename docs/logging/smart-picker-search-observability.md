# Smart Picker Search Observability Plan

This document translates the upstream OpenCode logging research into a concrete
future plan for the smart session picker. It is intentionally documentation
only; no instrumentation code is implemented yet.

## Goals

The plugin needs enough observability to answer:

- Did the picker open successfully?
- Which search mode ran?
- How long did each search phase take?
- How many sessions/documents/results were considered?
- Did the search fall back because a dependency was missing?
- Did preview loading or session navigation fail?

The logs should be useful when a user runs OpenCode with
`--print-logs --log-level DEBUG` or inspects the log file under OpenCode's log
directory. Routine logs should not create persistent user-visible noise in the
TUI.

## Recommended Primitive

Use `api.client.app.log()` for logs that should land in OpenCode's normal log
stream.

Do not import OpenCode internals such as `@opencode-ai/core/util/log` from this
plugin. The TUI plugin API exposes `api.client`, not a direct logger. The
upstream docs explicitly recommend `client.app.log()` for plugin structured
logging.

Use a single service name:

```text
smart-session-picker
```

If finer grouping is needed, use metadata fields such as `component: "search"`
or `component: "preview"` instead of many service names. That keeps filtering
simple in OpenCode's flat text logs.

## Event Names

Use stable, dotted event names in the `message` field:

- `picker.opened`
- `picker.closed`
- `environment.checked`
- `search.started`
- `search.completed`
- `search.failed`
- `search.cancelled`
- `preview.loaded`
- `preview.failed`
- `session.selected`
- `dependency.unavailable`

Keep event names low-cardinality. Put dynamic values in `extra`, not in
`message`.

## Levels

Use levels this way:

- `debug`: routine timing and high-frequency search events.
- `info`: picker opened, mode changed, explicit fallback, successful manual
  action.
- `warn`: degraded behavior that still works, such as missing optional semantic
  dependency.
- `error`: failed search, failed preview, or unexpected SDK/sidecar error.

Do not log every keystroke at `info`. Debounced searches can still become noisy.
Most per-query search diagnostics should be `debug`.

## Search Timing Shape

Record timings with `performance.now()` around plugin-owned async work. Use
`Date.now()` only for wall-clock event time if needed. OpenCode's internal
`Log.time()` helper is not public to the plugin, but the same started/completed
shape is easy to preserve through `client.app.log()`.

Recommended completed search metadata:

```ts
{
  component: "search",
  mode: "hybrid",
  queryLength: 18,
  queryHash: "optional-short-hash",
  resultCount: 25,
  candidateCount: 412,
  durationMs: 43,
  phases: {
    sessionListMs: 8,
    lexicalMs: 11,
    semanticMs: 19,
    mergeMs: 3,
  },
  dependencies: {
    opencodeDb: "available",
    sidecarIndex: "available",
    sqliteVec: "available",
    llamaServer: "available",
  },
}
```

Use `queryLength` by default. Only add `queryHash` if repeated-query
correlation becomes necessary. Do not log raw query text by default; session
queries can include private project names, customer names, or code snippets.

## Privacy And Cardinality

Avoid logging:

- Raw query text.
- Session titles.
- Message text.
- File contents or matched snippets.
- Absolute paths unless explicitly debugging a path resolution issue.
- API keys, model/provider tokens, auth data, or environment variable dumps.

Prefer bounded metadata:

- Counts.
- Durations.
- Search mode.
- Dependency state enum.
- Result ids only when needed for a specific debug mode.

If a future debug mode logs richer data, gate it behind an explicit plugin
option or environment variable and keep it out of the default path.

## Failure Logging

Every user-visible failure should have one corresponding structured log entry.
The TUI status bar or toast should stay concise; the log should carry the
diagnostic metadata.

Example failure metadata:

```ts
{
  component: "search",
  mode: "semantic",
  durationMs: 128,
  errorName: "Error",
  errorMessage: "sqlite-vec extension unavailable",
  dependency: "sqlite-vec",
}
```

Do not pass the raw error object unless the SDK safely serializes it. Convert
errors into a small object with name/message/stack only if stack logging is
explicitly needed. Stack traces can be large and can include local paths.

## UI Feedback Policy

Use UI surfaces separately from logs:

- Dialog status bar: persistent dependency health, selected mode, degraded mode.
- Toast: discrete user action failures, such as preview/session navigation
  failure or an unavailable mode switch.
- Logs: timings, counts, dependency details, and diagnostic errors.

Do not toast normal performance data.

## Suggested Helper

When implementation begins, add a small plugin-owned helper instead of calling
`api.client.app.log()` directly everywhere. The helper can handle SDK shape
differences, failures, and redaction in one place.

Sketch:

```ts
type LogLevel = "debug" | "info" | "warn" | "error"

async function logEvent(
  api: TuiPluginApi,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) {
  const payload = {
    service: "smart-session-picker",
    level,
    message,
    extra,
  }

  try {
    await api.client.app.log(payload)
  } catch {
    // Logging must never break the picker.
  }
}
```

If the installed SDK requires `{ body: payload }`, adapt the helper there. The
rest of the plugin should not care which SDK shape is active.

## Suggested Timer Helper

Keep timing code small and explicit:

```ts
function nowMs() {
  return performance.now()
}

function elapsedMs(start: number) {
  return Math.round(performance.now() - start)
}
```

For multi-phase search, collect phase durations near the code that owns each
phase. Avoid a generic tracing abstraction until the search pipeline is stable.

## Initial Instrumentation Points

Start with these points when implementation is requested:

1. Picker opened: after `api.ui.dialog.replace`.
2. Environment checked: after `checkSearchEnvironment`.
3. Search started/completed/failed: around `searchSessions`.
4. Preview loaded/failed: around `loadSessionPreview`.
5. Session selected: before route navigation, with mode and selected result
   rank, but without title/query text.

Likely files:

- `src/tui.tsx`
- `src/search/search.ts`
- `src/search/opencode-api.ts`
- `src/search/preview.ts`
- `src/search/status.ts`

## Local Verification

Use the disposable launcher so real OpenCode state is not touched:

```bash
bun run dev:opencode -- .
```

In the TUI, press `Ctrl-X` then `L` and exercise the picker.

For visible logs while testing:

```bash
bun run dev:opencode -- . --print-logs --log-level DEBUG
```

If the launcher does not pass those flags through today, inspect:

```bash
ls -la .opencode-dev/xdg/data/opencode/log
tail -f .opencode-dev/xdg/data/opencode/log/dev.log
```

The disposable launcher keeps OpenCode data, config, state, and cache under
`.opencode-dev/`, so these checks should not touch the user's real OpenCode
sessions or global config.

