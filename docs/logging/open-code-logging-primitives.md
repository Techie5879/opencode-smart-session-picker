# OpenCode Logging Primitives

This note documents the OpenCode logging and debug surfaces that matter for a
TUI plugin. The immediate goal is to understand what the smart session picker
should use later for search events, latency, and failure diagnostics.

## Summary

Use `api.client.app.log()` from the TUI plugin API for structured plugin logs.
Do not import OpenCode's internal `@opencode-ai/core/util/log` package from the
plugin. The internal logger is useful source context, but it is not part of the
public TUI plugin API.

OpenCode's log path is write-only from the SDK point of view. Users inspect logs
from disk or stderr:

- Normal log files: `~/.local/share/opencode/log/`
- Disposable dev launcher logs: `.opencode-dev/xdg/data/opencode/log/`
- Terminal output: run OpenCode with `--print-logs`
- More detail: run OpenCode with `--log-level DEBUG`
- Path discovery: `opencode debug paths`

For this repo's disposable launcher, the upstream child process also runs with
`OPENCODE_CHANNEL=local`, so local OpenCode builds typically write `dev.log`
instead of timestamped release-style log files.

## Core Logger

OpenCode's core logger lives in
`upstream/opencode/packages/core/src/util/log.ts`.

Important exports and behavior:

- `Level`: `DEBUG`, `INFO`, `WARN`, `ERROR`.
- `Log.init({ print, dev, level })`: configures the active sink and log level.
- `Log.create({ service })`: creates a structured logger.
- `logger.tag(key, value)`: mutates the logger's default tags.
- `logger.clone()`: copies current tags into a new logger.
- `logger.time(message, extra)`: logs a `started` entry and a `completed`
  entry with `duration` in milliseconds.
- `Log.file()`: returns the current log file path after file logging is
  initialized.

Log records are single-line text records. Metadata is rendered as `key=value`.
Objects are JSON-stringified. `Error` values are flattened to their message and
cause chain.

Log file behavior:

- If `print` is true, logs go to stderr.
- If `print` is false, logs go to `Global.Path.log`.
- Local/dev mode writes `dev.log`.
- Non-dev mode writes timestamped files like `2025-01-09T123456.log`.
- Cleanup keeps the newest 10 timestamped log files.

Source references:

- `upstream/opencode/packages/core/src/util/log.ts`
- `upstream/opencode/packages/core/src/global.ts`
- `upstream/opencode/packages/opencode/test/util/log.test.ts`

## CLI And TUI Initialization

The main CLI initializes logging from global flags:

```bash
opencode --print-logs --log-level DEBUG
```

The main entrypoint defaults local installs to `DEBUG` and release installs to
`INFO`. The TUI worker also calls `Log.init`, but it only forwards the
`--print-logs` behavior and uses the local-build default for level.

Relevant source files:

- `upstream/opencode/packages/opencode/src/index.ts`
- `upstream/opencode/packages/opencode/src/cli/cmd/tui/worker.ts`
- `upstream/opencode/packages/web/src/content/docs/cli.mdx`
- `upstream/opencode/packages/web/src/content/docs/troubleshooting.mdx`

## Public Plugin Logging API

TUI plugins receive a generated SDK client at `api.client`. The public logging
surface is:

```ts
await api.client.app.log({
  service: "smart-session-picker",
  level: "info",
  message: "search.completed",
  extra: {
    mode: "hybrid",
    queryLength: 12,
    resultCount: 20,
    durationMs: 37,
  },
})
```

Depending on the exact generated SDK version in use, the argument shape may be
flattened or may put fields under `body`. Existing upstream plugin docs show the
`body` shape:

```ts
await client.app.log({
  body: {
    service: "my-plugin",
    level: "info",
    message: "Plugin initialized",
    extra: { foo: "bar" },
  },
})
```

This repo should follow the installed SDK types when implementation starts. The
semantic contract is stable: `service`, lowercase `level`, `message`, and
optional `extra`.

The endpoint is `POST /log`, operation id `app.log`. It validates:

- `service: string`
- `level: "debug" | "info" | "warn" | "error"`
- `message: string`
- `extra?: Record<string, unknown>`

The handler creates an internal `Log.create({ service })` logger and dispatches
to `logger[level](message, extra)`.

Relevant source files:

- `upstream/opencode/packages/plugin/src/tui.ts`
- `upstream/opencode/packages/opencode/src/server/routes/control/index.ts`
- `upstream/opencode/packages/opencode/src/server/routes/instance/httpapi/groups/control.ts`
- `upstream/opencode/packages/opencode/src/server/routes/instance/httpapi/handlers/control.ts`
- `upstream/opencode/packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `upstream/opencode/packages/sdk/js/src/v2/gen/types.gen.ts`
- `upstream/opencode/packages/web/src/content/docs/plugins.mdx`

## Effect Logging And Observability

OpenCode's Effect runtime routes Effect logs into the same core logger through
`upstream/opencode/packages/core/src/effect/logger.ts`.

Behavior worth knowing:

- Effect log annotations become normal log metadata.
- The `service` annotation selects the service logger and is then removed from
  the extra metadata.
- `sessionID` is normalized to `session.id`.
- Effect log spans are emitted as `logSpan.<name>=Nms`.

`Observability.layer` installs the OpenCode Effect logger. If
`OTEL_EXPORTER_OTLP_ENDPOINT` is set, it also adds OTLP log and trace exporters.

This is relevant if we later move indexing/search work into an OpenCode server
extension or upstream patch. It is not directly available to this plugin through
the current TUI plugin API.

Relevant source files:

- `upstream/opencode/packages/core/src/effect/logger.ts`
- `upstream/opencode/packages/core/src/effect/observability.ts`
- `upstream/opencode/packages/opencode/src/effect/app-runtime.ts`
- `upstream/opencode/packages/opencode/src/effect/run-service.ts`
- `upstream/opencode/packages/opencode/test/effect/app-runtime-logger.test.ts`

## TUI Plugin Runtime Logging

The TUI plugin runtime logs plugin lifecycle failures under service
`tui.plugin`. It also mirrors warnings and failures to `console.warn` and
`console.error`.

The runtime catches plugin initialization failures, disposes the plugin's scope,
and continues loading other plugins. That protection covers plugin setup. It
does not replace explicit error handling in later async search/status/preview
callbacks.

Relevant source files:

- `upstream/opencode/packages/opencode/src/cli/cmd/tui/plugin/runtime.ts`
- `upstream/opencode/packages/opencode/test/cli/tui/plugin-lifecycle.test.ts`

## Debug Commands

`opencode debug` is a troubleshooting command group, not a log viewer.

Useful commands:

- `opencode debug paths`: prints `Global.Path`, including log/data/config paths.
- `opencode debug info`: prints version, OS, terminal, and configured plugins.
- `opencode debug config`: prints resolved config JSON.
- `opencode debug startup`: prints `performance.now()` for startup timing work.

Relevant source files:

- `upstream/opencode/packages/opencode/src/cli/cmd/debug/index.ts`
- `upstream/opencode/packages/opencode/src/cli/cmd/debug/config.ts`
- `upstream/opencode/packages/opencode/src/cli/cmd/debug/startup.ts`

## User-Facing TUI Surfaces

Logging is not the same as UI feedback. TUI plugins can use:

- `api.ui.toast(...)` for short-lived action feedback.
- The dialog body/status bar for persistent mode, dependency, or search state.
- `api.ui.DialogSelect` and `api.ui.dialog.replace/clear/setSize` for the
  picker itself.

Do not use toasts for routine search timings. They are user-visible and should
stay reserved for discrete failures or actions. The current smart picker status
bar is the better place for dependency health and mode state.

Relevant source files:

- `upstream/opencode/packages/plugin/src/tui.ts`
- `upstream/opencode/packages/opencode/src/cli/cmd/tui/plugin/api.tsx`
- `upstream/opencode/packages/opencode/src/cli/cmd/tui/ui/toast.tsx`
- `src/tui.tsx`

