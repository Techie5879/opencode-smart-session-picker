import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SearchDiagnostic, SearchEnvironmentStatus, SearchMode } from "./types"

export type LogLevel = "debug" | "info" | "warn" | "error"

const SERVICE = "smart-session-picker"

let sequence = 0

export function nextLogID(prefix: string) {
  sequence += 1
  return `${prefix}-${sequence}`
}

export function nowMs() {
  return performance.now()
}

export function elapsedMs(start: number) {
  return Math.max(0, Math.round(performance.now() - start))
}

export async function timePhase<T>(
  phases: Record<string, number>,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = nowMs()
  try {
    return await fn()
  } finally {
    phases[name] = elapsedMs(started)
  }
}

export function queryStats(query: string) {
  const trimmed = query.trim()
  return {
    hasQuery: trimmed.length > 0,
    queryLength: trimmed.length,
    queryTermCount: trimmed ? trimmed.split(/\s+/).length : 0,
  }
}

export function errorFields(error: unknown) {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    }
  }
  return {
    errorName: typeof error,
    errorMessage: String(error),
  }
}

export function diagnosticKinds(diagnostics: SearchDiagnostic[]) {
  return diagnostics.map((diagnostic) => diagnostic.kind)
}

export function dependencySnapshot(environment: SearchEnvironmentStatus | undefined) {
  if (!environment) return undefined
  return Object.fromEntries(
    environment.dependencies.map((dependency) => [
      dependency.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      dependency.state,
    ]),
  )
}

export function logEvent(
  api: TuiPluginApi,
  level: LogLevel,
  message: string,
  extra: Record<string, unknown> = {},
) {
  void api.client.app
    .log({
      service: SERVICE,
      level,
      message,
      extra,
    })
    .catch(() => {
      // Logging must never break the picker.
    })
}

export function logModeUnavailable(api: TuiPluginApi, mode: SearchMode, message: string, extra?: Record<string, unknown>) {
  logEvent(api, "warn", "dependency.unavailable", {
    component: "search",
    mode,
    reason: message,
    ...extra,
  })
}
