import type { Session } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SourceSessionCorpus } from "./types"

export async function listOpenCodeSessions(api: TuiPluginApi, query?: string) {
  const response = await api.client.session.list({
    roots: true,
    search: query?.trim() || undefined,
  })
  if (response.error) throw new Error(typeof response.error === "string" ? response.error : "Failed to list sessions")
  return response.data ?? []
}

export async function loadCorpusFromOpenCodeApi(api: TuiPluginApi, sessions: Session[]): Promise<SourceSessionCorpus[]> {
  const corpus: SourceSessionCorpus[] = []
  for (const session of sessions) {
    const response = await api.client.session.messages({ sessionID: session.id })
    if (response.error || !response.data) continue
    corpus.push({ session, messages: response.data })
  }
  return corpus
}
