import { createHash } from "node:crypto"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import type { SearchDocument } from "./types"

export const SEARCH_EXTRACTOR_VERSION = "3"

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function joinText(parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n")
}

function sourceText(part: Part) {
  switch (part.type) {
    case "text":
      if (part.ignored) return
      return part.text
    case "reasoning":
      return
    case "tool":
      return
    case "file":
      return joinText([
        part.filename,
        part.url,
        part.mime,
        part.source?.type === "file" || part.source?.type === "symbol" ? part.source.path : undefined,
        part.source?.type === "symbol" ? part.source.name : undefined,
        part.source?.type === "resource" ? part.source.uri : undefined,
      ])
    case "patch":
      return part.files.join("\n")
    case "subtask":
      return
    case "agent":
      return
    default:
      return
  }
}

export function extractSearchDocuments(session: Session, message: Message, part: Part): SearchDocument[] {
  if (message.role !== "user") return []
  const text = sourceText(part)
  if (!text) return []

  const metadata = {
    title: session.title,
    directory: session.directory,
    path: session.path,
    projectID: session.projectID,
    workspaceID: session.workspaceID,
    parentID: session.parentID,
    sessionTimeUpdated: session.time.updated,
    messageTimeCreated: message.time.created,
  }
  const indexedText = text

  return [
    {
      docID: `opencode:${session.id}:${message.id}:${part.id}:0`,
      sessionID: session.id,
      messageID: message.id,
      partID: part.id,
      chunkIndex: 0,
      role: message.role,
      partType: part.type,
      synthetic: part.type === "text" ? part.synthetic === true : false,
      ignored: part.type === "text" ? part.ignored === true : false,
      text: indexedText,
      metadata,
      sourceHash: hash({ session: session.id, message, part, metadata }),
    },
  ]
}

export function extractSessionDocuments(
  session: Session,
  messages: Array<{
    info: Message
    parts: Part[]
  }>,
) {
  const title = session.title?.trim()
  const titleDocument: SearchDocument[] = title
    ? [
        {
          docID: `opencode:${session.id}:title:0`,
          sessionID: session.id,
          chunkIndex: 0,
          synthetic: true,
          ignored: false,
          text: title,
          metadata: {
            title: session.title,
            directory: session.directory,
            path: session.path,
            projectID: session.projectID,
            workspaceID: session.workspaceID,
            parentID: session.parentID,
            sessionTimeUpdated: session.time.updated,
          },
          sourceHash: hash({ session: session.id, title, time: session.time.updated }),
        },
      ]
    : []

  return titleDocument.concat(messages.flatMap((message) =>
    message.parts.flatMap((part) => extractSearchDocuments(session, message.info, part)),
  ))
}
