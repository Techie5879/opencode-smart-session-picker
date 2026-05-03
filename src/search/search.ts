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

async function ensureBackgroundIndex(api: TuiPluginApi, sessions: Session[], sidecar: SearchSidecar, diagnostics: SearchDiagnostic[]) {
  if (indexedDbPath !== sidecar.config.searchDbPath) {
    indexedDbPath = sidecar.config.searchDbPath
    indexedOnce = false
  }
  if (indexedOnce || indexing) return
  if (sidecar.hasDocuments()) {
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
}

async function fallback(api: TuiPluginApi, query: string, diagnostics: SearchDiagnostic[]): Promise<SearchResponse> {
  diagnostics.push({ kind: "fallback", message: "Using OpenCode session search." })
  return { sessions: await listOpenCodeSessions(api, query), diagnostics }
}

export async function searchSessions(
  api: TuiPluginApi,
  query: string,
  input: { mode?: SearchMode } = {},
): Promise<SearchResponse> {
  const config: SearchConfig = { ...resolveSearchConfig(), ...input }
  const diagnostics: SearchDiagnostic[] = []
  const allSessions = await listOpenCodeSessions(api)

  let sidecar: SearchSidecar | undefined
  try {
    sidecar = await SearchSidecar.open(config)
    await ensureBackgroundIndex(api, allSessions, sidecar, diagnostics)
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
      return fallback(api, query, diagnostics)
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
      return fallback(api, query, diagnostics)
    }
    if (result.status === "no-match") return { sessions: [], diagnostics }
    return { sessions: orderByIDs(allSessions, result.sessionIDs), diagnostics }
  }

  if (!sidecar) return fallback(api, query, diagnostics)
  if (!query.trim()) {
    sidecar.close()
    return { sessions: allSessions, diagnostics }
  }

  const keyword = sidecar.searchFts(query)
  if (!keyword.length) {
    sidecar.close()
    return fallback(api, query, diagnostics)
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
