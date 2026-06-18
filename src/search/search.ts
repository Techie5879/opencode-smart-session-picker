import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { resolveSearchConfig } from "./config"
import { checkFzf } from "./dependencies"
import type { FzfHealth } from "./dependencies"
import { LlamaEmbeddingClient } from "./embedding"
import { runFzfSearch } from "./fzf"
import type { FzfCandidate } from "./fzf"
import {
  diagnosticKinds,
  elapsedMs,
  errorFields,
  logEvent,
  logModeUnavailable,
  nextLogID,
  nowMs,
  queryStats,
  timePhase,
} from "./logging"
import { listOpenCodeSessions, loadCorpusFromOpenCodeApi } from "./opencode-api"
import { blendHybridScores } from "./ranking"
import { SearchSidecar, closeSharedSidecar, openSharedSidecar, resetSharedSidecar } from "./sidecar"
import type { SessionIndexDelta } from "./sidecar"
import type { RankedCandidate, SearchConfig, SearchDiagnostic, SearchMode, SearchResponse } from "./types"
import { extractSessionDocuments } from "./extractor"

const FZF_HEALTH_TTL_MS = 30_000

let indexing: Promise<void> | undefined
let indexedOnce = false
let indexGeneration = 0
let cachedFzfHealth: { key: string; checkedAt: number; health: Promise<FzfHealth> } | undefined

export function invalidateSearchIndex(reason = "manual") {
  indexedOnce = false
  indexGeneration += 1
  return { reason, generation: indexGeneration }
}

export function searchIndexDebugState() {
  return {
    indexedOnce,
    indexing: Boolean(indexing),
    generation: indexGeneration,
  }
}

const INDEX_INVALIDATION_EVENTS = [
  "session.updated",
  "session.deleted",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "session.compacted",
] as const

export function registerSearchIndexInvalidation(api: TuiPluginApi) {
  // Intentionally no logging here: part-update events fire per streamed
  // token, and a log call per event floods the OpenCode log endpoint.
  const disposers = INDEX_INVALIDATION_EVENTS.map((type) =>
    api.event.on(type, () => {
      invalidateSearchIndex(type)
    }),
  )

  const dispose = () => {
    for (const item of disposers.splice(0)) item()
    closeSharedSidecar()
  }
  api.lifecycle.onDispose(dispose)
  return dispose
}

function byRecency(sessions: Session[]) {
  return [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
}

function orderByIDs(sessions: Session[], ids: string[]) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return ids.map((id) => byID.get(id)).filter((session): session is Session => Boolean(session))
}

function fzfHealthCacheKey(config: SearchConfig) {
  return config.fzfBin ?? "__PATH__"
}

async function checkFzfCached(config: SearchConfig) {
  const key = fzfHealthCacheKey(config)
  const expired = cachedFzfHealth && Date.now() - cachedFzfHealth.checkedAt > FZF_HEALTH_TTL_MS
  if (cachedFzfHealth?.key !== key || expired) {
    cachedFzfHealth = {
      key,
      checkedAt: Date.now(),
      health: checkFzf(config).catch((err) => {
        if (cachedFzfHealth?.key === key) cachedFzfHealth = undefined
        throw err
      }),
    }
  }
  return cachedFzfHealth!.health
}

/**
 * Fetch messages for the sessions named by the delta and apply them to the
 * sidecar. Incremental deltas only touch changed/removed sessions; full
 * deltas rebuild everything (first build or extractor upgrades).
 */
async function runIndexTask(
  api: TuiPluginApi,
  config: SearchConfig,
  sessions: Session[],
  delta: Exclude<SessionIndexDelta, { kind: "none" }>,
) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const targets =
    delta.kind === "full"
      ? sessions
      : delta.changed.map((id) => byID.get(id)).filter((session): session is Session => Boolean(session))
  const corpus = targets.length ? await loadCorpusFromOpenCodeApi(api, targets) : []
  if (api.lifecycle.signal.aborted) return

  let sidecar = await openSharedSidecar(config)
  let vectorLoaded = config.disableVector ? false : await sidecar.loadVectorExtension()

  const applyWrite = (target: SearchSidecar, loaded: boolean) => {
    if (delta.kind === "full") target.rebuildCorpus(corpus)
    else target.upsertSessions(corpus, delta.removed, loaded)
  }

  try {
    applyWrite(sidecar, vectorLoaded)
  } catch (err) {
    if (!SearchSidecar.isRecoverableCacheError(err)) throw err
    sidecar = await resetSharedSidecar(config)
    vectorLoaded = config.disableVector ? false : await sidecar.loadVectorExtension()
    applyWrite(sidecar, vectorLoaded)
  }

  // Embeddings are only maintained for hybrid mode with vectors enabled.
  if (config.mode !== "hybrid" || config.disableVector || config.alpha <= 0 || !vectorLoaded) return
  if (api.lifecycle.signal.aborted) return

  const client = new LlamaEmbeddingClient(config)
  if (!(await client.health())) return

  const state = sidecar.getMeta("vector_state")?.value
  if (delta.kind === "full" || state === "unavailable" || !state) {
    // Build the whole vector index from the already-indexed document texts.
    const documents = sidecar.allDocumentTexts()
    if (!documents.length) return
    const embeddings = await client.embedDocuments(documents.map((document) => document.text))
    if (api.lifecycle.signal.aborted) return
    await sidecar.replaceVectorEmbeddings(documents, embeddings)
    return
  }

  // Incremental: embed only documents whose vectors are missing. This also
  // self-heals documents whose embedding failed in an earlier pass.
  const pending = sidecar.documentsMissingEmbeddings()
  const embeddings = pending.length ? await client.embedDocuments(pending.map((document) => document.text)) : []
  if (api.lifecycle.signal.aborted) return
  await sidecar.upsertVectorEmbeddings(pending, embeddings)
}

/**
 * Keep the sidecar index in sync. Searches only block on indexing when the
 * index is completely empty (nothing usable to serve); otherwise stale-but-
 * usable results are returned while the index updates in the background.
 */
async function ensureBackgroundIndex(
  api: TuiPluginApi,
  config: SearchConfig,
  sessions: Session[],
  sidecar: SearchSidecar,
  diagnostics: SearchDiagnostic[],
  allowBlocking: boolean,
) {
  if (api.lifecycle.signal.aborted) return
  if (indexing) {
    if (allowBlocking && !sidecar.hasDocuments()) await indexing
    return
  }

  const delta = sidecar.indexDelta(sessions)
  if (delta.kind === "none") {
    indexedOnce = true
    return
  }

  const blocking = allowBlocking && !sidecar.hasDocuments()
  diagnostics.push({
    kind: "indexing",
    message: blocking
      ? "Building the local search index."
      : "Updating the local search index in the background.",
  })

  const generation = indexGeneration
  const task = runIndexTask(api, config, sessions, delta).then(() => {
    if (!api.lifecycle.signal.aborted && generation === indexGeneration) indexedOnce = true
  })
  indexing = task
    .catch((err) => {
      logEvent(api, "error", "search.index_failed", {
        component: "search",
        deltaKind: delta.kind,
        sessionCount: sessions.length,
        ...errorFields(err),
      })
    })
    .finally(() => {
      indexing = undefined
    })
  if (blocking) await task
}

export async function searchSessions(
  api: TuiPluginApi,
  query: string,
  input: { mode?: SearchMode } = {},
): Promise<SearchResponse> {
  const searchID = nextLogID("search")
  const started = nowMs()
  const phases: Record<string, number> = {}
  const config: SearchConfig = { ...resolveSearchConfig(), ...input }
  const diagnostics: SearchDiagnostic[] = []

  logEvent(api, "debug", "search.started", {
    component: "search",
    searchID,
    mode: config.mode,
    ...queryStats(query),
  })

  function completed(response: SearchResponse, extra: Record<string, unknown> = {}) {
    logEvent(api, response.modeUnavailable ? "warn" : "debug", "search.completed", {
      component: "search",
      searchID,
      mode: config.mode,
      ...queryStats(query),
      durationMs: elapsedMs(started),
      phases,
      resultCount: response.sessions.length,
      diagnosticKinds: diagnosticKinds(response.diagnostics),
      modeUnavailable: response.modeUnavailable,
      ...extra,
    })
    return response
  }

  try {
    const allSessions = await timePhase(phases, "sessionListMs", () => listOpenCodeSessions(api))

    // Empty query: list all sessions ordered by most recent activity,
    // matching the built-in picker. Index warmup stays non-blocking.
    if (!query.trim()) {
      try {
        await timePhase(phases, "indexWarmupMs", async () => {
          const sidecar = await openSharedSidecar(config)
          await ensureBackgroundIndex(api, config, allSessions, sidecar, diagnostics, false)
        })
      } catch {
        /* sidecar not needed for empty-query listing */
      }
      return completed({ sessions: byRecency(allSessions), diagnostics }, { candidateCount: allSessions.length })
    }

    let sidecar: SearchSidecar | undefined
    try {
      sidecar = await timePhase(phases, "sidecarOpenMs", () => openSharedSidecar(config))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sidecar search database could not be opened."
      logModeUnavailable(api, config.mode, message, { searchID, dependency: "sidecar-index" })
      diagnostics.push({ kind: "sidecar-unavailable", message })
    }

    if (sidecar) {
      try {
        await timePhase(phases, "indexEnsureMs", () =>
          ensureBackgroundIndex(api, config, allSessions, sidecar!, diagnostics, true),
        )
      } catch (err) {
        diagnostics.push({
          kind: "sidecar-stale",
          message: err instanceof Error ? err.message : "Search index build failed; results may be incomplete.",
        })
      }
    }

    if (!sidecar) {
      const modeUnavailable = `Search index is unavailable - ${config.mode} search requires the sidecar database.`
      return completed(
        { sessions: [], diagnostics, modeUnavailable },
        { candidateCount: allSessions.length },
      )
    }

    if (config.mode === "fzf") {
      const fzfSidecar = sidecar
      const fzf = await timePhase(phases, "fzfCheckMs", () => checkFzfCached(config))
      if (fzf.state !== "available" || !fzf.bin) {
        diagnostics.push({ kind: "fzf-unavailable", message: fzf.message ?? "fzf is unavailable." })
        const modeUnavailable = "fzf is not installed - install fzf to use this mode."
        logModeUnavailable(api, "fzf", modeUnavailable, {
          searchID,
          dependency: "fzf",
          dependencyState: fzf.state,
        })
        return completed(
          { sessions: [], diagnostics, modeUnavailable },
          { candidateCount: allSessions.length },
        )
      }
      const fzfBin = fzf.bin

      const keyword = await timePhase(phases, "keywordSearchMs", async () => fzfSidecar.searchFts(query))
      if (!keyword.length) {
        return completed(
          { sessions: [], diagnostics },
          { candidateCount: allSessions.length, keywordCandidateCount: 0 },
        )
      }
      const byID = new Map(allSessions.map((session) => [session.id, session]))
      const candidates: FzfCandidate[] = []
      for (const row of keyword) {
        const session = byID.get(row.sessionID)
        if (session) candidates.push({ session, snippet: row.snippet })
      }
      const result = await timePhase(phases, "fzfSearchMs", () =>
        runFzfSearch({
          bin: fzfBin,
          query,
          candidates,
        }),
      )
      if (result.status === "error") {
        diagnostics.push({ kind: "fzf-unavailable", message: result.message })
        logModeUnavailable(api, "fzf", result.message, {
          searchID,
          dependency: "fzf",
        })
        return completed(
          {
            sessions: [],
            diagnostics,
            modeUnavailable: `fzf error: ${result.message}`,
          },
          { candidateCount: allSessions.length, fzfStatus: result.status },
        )
      }
      if (result.status === "no-match") {
        return completed(
          { sessions: [], diagnostics },
          { candidateCount: allSessions.length, fzfStatus: result.status },
        )
      }
      return completed(
        { sessions: orderByIDs(allSessions, result.sessionIDs), diagnostics },
        { candidateCount: allSessions.length, keywordCandidateCount: keyword.length, fzfStatus: result.status },
      )
    }

    // Hybrid mode: keyword and vector search run independently so purely
    // semantic matches surface even when no keyword candidate exists.
    const hybridSidecar = sidecar
    const keyword = await timePhase(phases, "keywordSearchMs", async () => hybridSidecar.searchFts(query))

    let vector: RankedCandidate[] = []
    if (!config.disableVector && config.alpha > 0) {
      const client = new LlamaEmbeddingClient(config)
      try {
        const healthy = await timePhase(phases, "embeddingHealthMs", () => client.health())
        if (healthy) {
          const embedding = await timePhase(phases, "embeddingQueryMs", () => client.embedQuery(query))
          vector = await timePhase(phases, "vectorSearchMs", () => hybridSidecar.searchVector(embedding))
        } else {
          diagnostics.push({
            kind: "embedding-unavailable",
            message: "Embedding server is unavailable; using keyword search.",
          })
          logModeUnavailable(api, "hybrid", "Embedding server is unavailable; using keyword search.", {
            searchID,
            dependency: "llama-server",
          })
        }
      } catch (err) {
        diagnostics.push({
          kind: "embedding-unavailable",
          message: err instanceof Error ? err.message : "Embedding query failed; using keyword search.",
        })
        logModeUnavailable(
          api,
          "hybrid",
          err instanceof Error ? err.message : "Embedding query failed; using keyword search.",
          {
            searchID,
            dependency: "llama-server",
          },
        )
      }
    }

    if (!keyword.length && !vector.length) {
      return completed(
        { sessions: [], diagnostics },
        { candidateCount: allSessions.length, keywordCandidateCount: 0, vectorCandidateCount: 0 },
      )
    }

    const { ranked, diagnostics: rankingDiagnostics } = await timePhase(phases, "rankingMs", async () =>
      blendHybridScores({
        keyword,
        vector,
        alpha: config.alpha,
        vectorAvailable: vector.length > 0,
      }),
    )
    diagnostics.push(...rankingDiagnostics)
    return completed(
      { sessions: orderByIDs(allSessions, ranked.map((row) => row.sessionID)), diagnostics },
      {
        candidateCount: allSessions.length,
        keywordCandidateCount: keyword.length,
        vectorCandidateCount: vector.length,
        rankedCandidateCount: ranked.length,
        alpha: config.alpha,
        vectorEnabled: !config.disableVector,
      },
    )
  } catch (err) {
    logEvent(api, "error", "search.failed", {
      component: "search",
      searchID,
      mode: config.mode,
      ...queryStats(query),
      durationMs: elapsedMs(started),
      phases,
      ...errorFields(err),
    })
    throw err
  }
}
