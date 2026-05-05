import type { Message, Part, Session } from "@opencode-ai/sdk/v2"

export type SearchMode = "hybrid" | "fzf"

export type VectorState = "enabled" | "disabled" | "unavailable" | "stale"

export type DependencyState = "available" | "unavailable" | "error" | "disabled" | "checking"

export type SearchDiagnostic = {
  kind:
    | "indexing"
    | "sidecar-unavailable"
    | "source-db-unavailable"
    | "vector-disabled"
    | "embedding-unavailable"
    | "fzf-unavailable"
    | "sidecar-stale"
  message: string
}

export type SearchConfig = {
  mode: SearchMode
  alpha: number
  fzfBin?: string
  searchDbPath: string
  sourceDbPath?: string
  embedBaseUrl: string
  embedModel?: string
  disableVector: boolean
  documentPrefix: string
  queryPrefix: string
  sqliteLibPath?: string
  sqliteVecExtension?: string
}

export type SearchDocument = {
  docID: string
  sessionID: string
  messageID?: string
  partID?: string
  chunkIndex: number
  role?: Message["role"]
  partType?: Part["type"]
  synthetic: boolean
  ignored: boolean
  text: string
  metadata: Record<string, unknown>
  sourceHash: string
}

export type RankedCandidate = {
  sessionID: string
  score: number
  keywordScore?: number
  vectorScore?: number
  snippet?: string
}

export type SearchResponse = {
  sessions: Session[]
  diagnostics: SearchDiagnostic[]
  modeUnavailable?: string
}

export type SearchModeStatus = {
  mode: SearchMode
  state: DependencyState
  active: boolean
  message: string
}

export type SearchDependencyStatus = {
  name: "OpenCode DB" | "sidecar index" | "sqlite-vec" | "llama-server" | "fzf"
  state: DependencyState
  message: string
}

export type SearchEnvironmentStatus = {
  mode: SearchMode
  alpha: number
  modes: SearchModeStatus[]
  dependencies: SearchDependencyStatus[]
  modeDependencies: {
    hybrid: SearchDependencyStatus[]
    fzf: SearchDependencyStatus[]
  }
}

export type SourceSessionCorpus = {
  session: Session
  messages: Array<{
    info: Message
    parts: Part[]
  }>
}
