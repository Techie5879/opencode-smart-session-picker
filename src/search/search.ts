import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { resolveSearchConfig } from "./config"
import { checkFzf } from "./dependencies"
import { LlamaEmbeddingClient } from "./embedding"
import { runFzfSearch } from "./fzf"
import { listOpenCodeSessions, loadCorpusFromOpenCodeApi } from "./opencode-api"
import { blendHybridScores } from "./ranking"
import { SearchSidecar } from "./sidecar"
import type { RankedCandidate, SearchConfig, SearchDiagnostic, SearchMode, SearchResponse } from "./types"
import { extractSessionDocuments } from "./extractor"

let indexing: Promise<void> | undefined
let indexedOnce = false
let indexedDbPath: string | undefined

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
  indexing = loadCorpusFromOpenCodeApi(api, sessions)
    .then(async (corpus) => {
      const workerSidecar = await SearchSidecar.open(sidecar.config)
      try {
        workerSidecar.rebuildCorpus(corpus)
        if (!workerSidecar.config.disableVector) {
          const documents = corpus.flatMap((entry) => extractSessionDocuments(entry.session, entry.messages))
          const client = new LlamaEmbeddingClient(workerSidecar.config)
          if (await client.health()) {
            const embeddings = await client.embedDocuments(documents.map((document) => document.text))
            await workerSidecar.replaceVectorEmbeddings(documents, embeddings)
          }
        }
      } finally {
        workerSidecar.close()
      }
    })
    .then(() => {
      indexedOnce = true
    })
    .finally(() => {
      indexing = undefined
    })
  if (blocking) await indexing
}

export async function searchSessions(
  api: TuiPluginApi,
  query: string,
  input: { mode?: SearchMode } = {},
): Promise<SearchResponse> {
  const config: SearchConfig = { ...resolveSearchConfig(), ...input }
  const diagnostics: SearchDiagnostic[] = []
  const allSessions = await listOpenCodeSessions(api)

  // Empty query: return all sessions regardless of mode or dep availability
  if (!query.trim()) {
    let sidecar: SearchSidecar | undefined
    try {
      sidecar = await SearchSidecar.open(config)
      await ensureBackgroundIndex(api, allSessions, sidecar, diagnostics)
    } catch {
      /* sidecar not needed for empty-query listing */
    } finally {
      sidecar?.close()
    }
    return { sessions: allSessions, diagnostics }
  }

  let sidecar: SearchSidecar | undefined
  try {
    sidecar = await SearchSidecar.open(config)
    await ensureBackgroundIndex(api, allSessions, sidecar, diagnostics, true)
  } catch (err) {
    diagnostics.push({
      kind: "sidecar-unavailable",
      message: err instanceof Error ? err.message : "Sidecar search database could not be opened.",
    })
  }

  if (config.mode === "fzf") {
    const fzf = await checkFzf(config)
    if (fzf.state !== "available" || !fzf.bin) {
      diagnostics.push({ kind: "fzf-unavailable", message: fzf.message ?? "fzf is unavailable." })
      sidecar?.close()
      return {
        sessions: [],
        diagnostics,
        modeUnavailable: "fzf is not installed — install fzf to use this mode.",
      }
    }

    const snippets = sidecar?.snippetsForSessions(allSessions.map((session) => session.id)) ?? new Map<string, string>()
    const result = await runFzfSearch({
      bin: fzf.bin,
      query,
      candidates: allSessions.map((session) => ({ session, snippet: snippets.get(session.id) })),
    })
    sidecar?.close()
    if (result.status === "error") {
      diagnostics.push({ kind: "fzf-unavailable", message: result.message })
      return {
        sessions: [],
        diagnostics,
        modeUnavailable: `fzf error: ${result.message}`,
      }
    }
    if (result.status === "no-match") return { sessions: [], diagnostics }
    return { sessions: orderByIDs(allSessions, result.sessionIDs), diagnostics }
  }

  // Hybrid mode
  if (!sidecar) {
    return {
      sessions: [],
      diagnostics,
      modeUnavailable: "Search index is unavailable — hybrid search requires the sidecar database.",
    }
  }

  const keyword = sidecar.searchFts(query)
  if (!keyword.length) {
    sidecar.close()
    return { sessions: [], diagnostics }
  }

  let vector: RankedCandidate[] = []
  if (!config.disableVector && config.alpha > 0) {
    const client = new LlamaEmbeddingClient(config)
    try {
      if (await client.health()) vector = await sidecar.searchVector(await client.embedQuery(query))
      else diagnostics.push({ kind: "embedding-unavailable", message: "Embedding server is unavailable; using keyword search." })
    } catch (err) {
      diagnostics.push({
        kind: "embedding-unavailable",
        message: err instanceof Error ? err.message : "Embedding query failed; using keyword search.",
      })
    }
  }

  const { ranked, diagnostics: rankingDiagnostics } = blendHybridScores({
    keyword,
    vector,
    alpha: config.alpha,
    vectorAvailable: vector.length > 0,
  })
  diagnostics.push(...rankingDiagnostics)
  sidecar.close()
  return { sessions: orderByIDs(allSessions, ranked.map((row) => row.sessionID)), diagnostics }
}
