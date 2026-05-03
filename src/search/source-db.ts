import { Database } from "bun:sqlite"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import type { SourceSessionCorpus } from "./types"

function parseJson(value: unknown) {
  if (typeof value !== "string") return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value) || 0
}

export function readSourceCorpusFromDb(sourceDbPath: string): SourceSessionCorpus[] {
  const db = new Database(sourceDbPath, { readonly: true })
  try {
    const rows = db
      .prepare(`
        select
          s.id as session_id,
          s.slug as session_slug,
          s.project_id,
          s.workspace_id,
          s.parent_id,
          s.directory,
          s.path,
          s.title,
          s.time_created as session_time_created,
          s.time_updated as session_time_updated,
          m.id as message_id,
          m.time_created as message_time_created,
          m.data as message_data,
          p.id as part_id,
          p.time_created as part_time_created,
          p.data as part_data
        from session s
        join message m on m.session_id = s.id
        join part p on p.message_id = m.id and p.session_id = s.id
        where s.time_archived is null
        order by s.time_updated desc, m.time_created asc, m.id asc, p.time_created asc, p.id asc
      `)
      .all() as Array<Record<string, unknown>>

    const bySession = new Map<string, SourceSessionCorpus>()
    const byMessage = new Map<string, { info: Message; parts: Part[] }>()

    for (const row of rows) {
      const sessionID = String(row.session_id)
      let entry = bySession.get(sessionID)
      if (!entry) {
        const session: Session = {
          id: sessionID,
          slug: String(row.session_slug ?? sessionID),
          projectID: String(row.project_id),
          version: "unknown",
          workspaceID: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
          directory: String(row.directory ?? ""),
          path: typeof row.path === "string" ? row.path : undefined,
          parentID: typeof row.parent_id === "string" ? row.parent_id : undefined,
          title: String(row.title ?? ""),
          time: {
            created: numberValue(row.session_time_created),
            updated: numberValue(row.session_time_updated),
          },
        }
        entry = { session, messages: [] }
        bySession.set(sessionID, entry)
      }

      const messageID = String(row.message_id)
      const messageKey = `${sessionID}:${messageID}`
      let message = byMessage.get(messageKey)
      if (!message) {
        const data = parseJson(row.message_data)
        const role = data.role === "assistant" ? "assistant" : "user"
        const info = {
          ...data,
          id: messageID,
          sessionID,
          role,
          time: {
            ...(typeof data.time === "object" && data.time ? data.time : {}),
            created: numberValue(row.message_time_created),
          },
        } as Message
        message = { info, parts: [] }
        entry.messages.push(message)
        byMessage.set(messageKey, message)
      }

      const partID = String(row.part_id)
      const partData = parseJson(row.part_data)
      message.parts.push({
        ...partData,
        id: partID,
        sessionID,
        messageID,
      } as Part)
    }

    return [...bySession.values()]
  } finally {
    db.close()
  }
}
