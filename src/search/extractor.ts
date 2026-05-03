import { createHash } from "node:crypto"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import type { SearchDocument } from "./types"

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
      return joinText([
        part.tool,
        part.state.status === "completed" ? part.state.title : undefined,
        part.state.status === "completed" ? part.state.output : undefined,
        part.state.status === "error" ? part.state.error : undefined,
      ])
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
      return joinText([part.prompt, part.description, part.agent, part.command])
    case "agent":
      return joinText([part.name, part.source?.value])
    default:
      return
  }
}

export function extractSearchDocuments(session: Session, message: Message, part: Part): SearchDocument[] {
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
  const indexedText = joinText([
    `Title: ${session.title}`,
    `Role: ${message.role}`,
    session.path ? `Path: ${session.path}` : session.directory ? `Directory: ${session.directory}` : undefined,
    text,
  ])

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
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => extractSearchDocuments(session, message.info, part)),
  )
}
