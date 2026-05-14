import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { resolveSearchConfig } from "./config"
import { checkFzf } from "./dependencies"
import { LlamaEmbeddingClient } from "./embedding"
import { runFzfSearch } from "./fzf"
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
import { SearchSidecar } from "./sidecar"
import type { RankedCandidate, SearchConfig, SearchDiagnostic, SearchMode, SearchResponse } from "./types"
import { extractSessionDocuments } from "./extractor"

let indexing: Promise<void> | undefined
let indexedOnce = false
let indexedDbPath: string | undefined
let indexGeneration = 0

export function invalidateSearchIndex(reason = "manual") {
  indexedOnce = false
  indexGeneration += 1
  return { reason, generation: indexGeneration }
}

export function searchIndexDebugState() {
  return {
    indexedOnce,
    indexedDbPath,
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
  const disposers = INDEX_INVALIDATION_EVENTS.map((type) =>
    api.event.on(type, (event) => {
      const invalidation = invalidateSearchIndex(type)
      logEvent(api, "debug", "search.index_invalidated", {
        component: "search",
        reason: type,
        generation: invalidation.generation,
        eventType: event.type,
      })
    }),
  )

  const dispose = () => {
    for (const item of disposers.splice(0)) item()
  }
  api.lifecycle.onDispose(dispose)
  return dispose
}

function orderByIDs(sessions: Session[], ids: string[]) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return ids.map((id) => byID.get(id)).filter((session): session is Session => Boolean(session))
}

async function ensureBackgroundIndex(
  api: TuiPluginApi,
  sessions: Session[],
  sidecar: SearchSidecar,
  diagnostics: SearchDiagnostic[],
  blocking = false,
) {
  if (api.lifecycle.signal.aborted) return
  if (indexedDbPath !== sidecar.config.searchDbPath) {
    indexedDbPath = sidecar.config.searchDbPath
    indexedOnce = false
  }
  if (indexedOnce && !sidecar.needsReindex(sessions)) return
  if (indexing) {
    if (blocking) await indexing
    return
  }
  if (!sidecar.needsReindex(sessions)) {
    indexedOnce = true
    return
  }

  diagnostics.push({ kind: "indexing", message: "Building the local search index in the background." })
  const generation = indexGeneration
  const indexTask = loadCorpusFromOpenCodeApi(api, sessions)
    .then(async (corpus) => {
      if (api.lifecycle.signal.aborted || generation !== indexGeneration) return
      const workerSidecar = await SearchSidecar.open(sidecar.config)
      try {
        if (api.lifecycle.signal.aborted || generation !== indexGeneration) return
        workerSidecar.rebuildCorpus(corpus)
        if (!workerSidecar.config.disableVector) {
          const documents = corpus.flatMap((entry) => extractSessionDocuments(entry.session, entry.messages))
          const client = new LlamaEmbeddingClient(workerSidecar.config)
          if (await client.health()) {
            if (api.lifecycle.signal.aborted || generation !== indexGeneration) return
            const embeddings = await client.embedDocuments(documents.map((document) => document.text))
            if (api.lifecycle.signal.aborted || generation !== indexGeneration) return
            await workerSidecar.replaceVectorEmbeddings(documents, embeddings)
          }
        }
      } finally {
        workerSidecar.close()
      }
    })
    .then(() => {
      if (!api.lifecycle.signal.aborted && generation === indexGeneration) indexedOnce = true
    })
    .finally(() => {
      if (indexing === indexTask) indexing = undefined
    })
  indexing = indexTask
  if (blocking) await indexing
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

    let sidecar: SearchSidecar | undefined
    try {
      // Empty query: return all sessions regardless of mode or dependency availability.
      if (!query.trim()) {
        try {
          await timePhase(phases, "indexWarmupMs", async () => {
            sidecar = await SearchSidecar.open(config)
            await ensureBackgroundIndex(api, allSessions, sidecar, diagnostics)
          })
        } catch {
          /* sidecar not needed for empty-query listing */
        } finally {
          sidecar?.close()
          sidecar = undefined
        }
        return completed({ sessions: allSessions, diagnostics }, { candidateCount: allSessions.length })
      }

      try {
        await timePhase(phases, "sidecarOpenIndexMs", async () => {
          sidecar = await SearchSidecar.open(config)
          await ensureBackgroundIndex(api, allSessions, sidecar, diagnostics, true)
        })
      } catch (err) {
        logModeUnavailable(
          api,
          config.mode,
          err instanceof Error ? err.message : "Sidecar search database could not be opened.",
          {
            searchID,
            dependency: "sidecar-index",
          },
        )
        diagnostics.push({
          kind: "sidecar-unavailable",
          message: err instanceof Error ? err.message : "Sidecar search database could not be opened.",
        })
      }

      if (config.mode === "fzf") {
        const fzf = await timePhase(phases, "fzfCheckMs", () => checkFzf(config))
        if (fzf.state !== "available" || !fzf.bin) {
          diagnostics.push({ kind: "fzf-unavailable", message: fzf.message ?? "fzf is unavailable." })
          const modeUnavailable = "fzf is not installed - install fzf to use this mode."
          logModeUnavailable(api, "fzf", modeUnavailable, {
            searchID,
            dependency: "fzf",
            dependencyState: fzf.state,
          })
          return completed(
            {
              sessions: [],
              diagnostics,
              modeUnavailable,
            },
            { candidateCount: allSessions.length },
          )
        }
        const fzfBin = fzf.bin

        const snippets = await timePhase(
          phases,
          "snippetLoadMs",
          async () => sidecar?.snippetsForSessions(allSessions.map((session) => session.id)) ?? new Map<string, string>(),
        )
        const result = await timePhase(phases, "fzfSearchMs", () =>
          runFzfSearch({
            bin: fzfBin,
            query,
            candidates: allSessions.map((session) => ({ session, snippet: snippets.get(session.id) })),
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
          { candidateCount: allSessions.length, fzfStatus: result.status },
        )
      }

      // Hybrid mode
      if (!sidecar) {
        const modeUnavailable = "Search index is unavailable - hybrid search requires the sidecar database."
        return completed(
          {
            sessions: [],
            diagnostics,
            modeUnavailable,
          },
          { candidateCount: allSessions.length },
        )
      }
      const hybridSidecar = sidecar

      const keyword = await timePhase(phases, "keywordSearchMs", async () => hybridSidecar.searchFts(query))
      if (!keyword.length) {
        return completed(
          { sessions: [], diagnostics },
          { candidateCount: allSessions.length, keywordCandidateCount: 0 },
        )
      }

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
    } finally {
      sidecar?.close()
    }
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
