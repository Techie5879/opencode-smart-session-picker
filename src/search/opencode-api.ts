import type { Session } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SourceSessionCorpus } from "./types"

const CORPUS_FETCH_CONCURRENCY = 8

export async function listOpenCodeSessions(api: TuiPluginApi, query?: string) {
  const response = await api.client.session.list({
    roots: true,
    search: query?.trim() || undefined,
  })
  if (response.error) throw new Error(typeof response.error === "string" ? response.error : "Failed to list sessions")
  return response.data ?? []
}

export async function loadCorpusFromOpenCodeApi(api: TuiPluginApi, sessions: Session[]): Promise<SourceSessionCorpus[]> {
  const corpus: (SourceSessionCorpus | undefined)[] = new Array(sessions.length)
  let cursor = 0

  async function worker() {
    while (cursor < sessions.length) {
      const index = cursor++
      const session = sessions[index]!
      const response = await api.client.session.messages({ sessionID: session.id })
      if (response.error || !response.data) continue
      corpus[index] = { session, messages: response.data }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CORPUS_FETCH_CONCURRENCY, Math.max(sessions.length, 1)) }, () => worker()),
  )
  return corpus.filter((entry): entry is SourceSessionCorpus => Boolean(entry))
}
