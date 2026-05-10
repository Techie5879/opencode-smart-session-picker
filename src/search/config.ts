import { constants, existsSync, readdirSync, statSync } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import type { SearchConfig, SearchMode } from "./types"

declare const OPENCODE_CHANNEL: string | undefined

function boolEnv(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes"
}

export function parseAlpha(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 0.5
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0.5
  if (parsed < 0) return 0
  if (parsed > 1) return 1
  return parsed
}

function parseMode(value: string | undefined): SearchMode {
  return value === "hybrid" ? "hybrid" : "fzf"
}

function xdgDataHome(env: NodeJS.ProcessEnv = process.env) {
  return env.XDG_DATA_HOME ?? path.join(env.HOME ?? process.cwd(), ".local", "share")
}

function installationChannel(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_CHANNEL) return { channel: env.OPENCODE_CHANNEL, explicit: true }
  if (typeof OPENCODE_CHANNEL === "string") return { channel: OPENCODE_CHANNEL, explicit: true }
  return { channel: "latest", explicit: false }
}

function channelDbPath(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const { channel } = installationChannel(env)
  if (boolEnv(env.OPENCODE_DISABLE_CHANNEL_DB) || ["latest", "beta", "prod"].includes(channel)) {
    return path.join(dataDir, "opencode.db")
  }
  const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(dataDir, `opencode-${safe}.db`)
}

function existingOpenCodeDb(dataDir: string) {
  try {
    return readdirSync(dataDir)
      .filter((entry) => /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/.test(entry))
      .map((entry) => {
        const file = path.join(dataDir, entry)
        return { file, mtime: statSync(file).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)[0]?.file
  } catch {
    return undefined
  }
}

export function resolveSourceDbPath(env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_SMART_PICKER_SOURCE_DB) return path.resolve(env.OPENCODE_SMART_PICKER_SOURCE_DB)
  if (env.OPENCODE_DB) {
    if (env.OPENCODE_DB === ":memory:" || path.isAbsolute(env.OPENCODE_DB)) return env.OPENCODE_DB
    return path.join(xdgDataHome(env), "opencode", env.OPENCODE_DB)
  }
  const dataDir = path.join(xdgDataHome(env), "opencode")
  const expected = channelDbPath(dataDir, env)
  if (existsSync(expected)) return expected
  if (boolEnv(env.OPENCODE_DISABLE_CHANNEL_DB) || installationChannel(env).explicit) return expected
  return existingOpenCodeDb(dataDir) ?? expected
}

export function resolveSearchDbPath(sourceDbPath: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCODE_SMART_PICKER_SEARCH_DB) return path.resolve(env.OPENCODE_SMART_PICKER_SEARCH_DB)
  if (sourceDbPath && sourceDbPath !== ":memory:") return path.join(path.dirname(sourceDbPath), "opencode-search.db")
  return path.join(process.cwd(), ".opencode-search.db")
}

export function resolveSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  const sourceDbPath = resolveSourceDbPath(env)
  return {
    mode: parseMode(env.OPENCODE_SMART_PICKER_SEARCH_MODE),
    alpha: parseAlpha(env.OPENCODE_SMART_PICKER_HYBRID_ALPHA),
    fzfBin: env.OPENCODE_SMART_PICKER_FZF_BIN,
    searchDbPath: resolveSearchDbPath(sourceDbPath, env),
    sourceDbPath,
    embedBaseUrl: env.OPENCODE_SMART_PICKER_EMBED_BASE_URL ?? "http://127.0.0.1:8081",
    embedModel: env.OPENCODE_SMART_PICKER_EMBED_MODEL,
    disableVector: boolEnv(env.OPENCODE_SMART_PICKER_DISABLE_VECTOR),
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    sqliteLibPath: env.OPENCODE_SMART_PICKER_SQLITE_LIB,
    sqliteVecExtension: env.OPENCODE_SMART_PICKER_SQLITE_VEC_EXT,
  }
}

export async function fileExists(file: string) {
  return access(file, constants.F_OK)
    .then(() => true)
    .catch(() => false)
}
