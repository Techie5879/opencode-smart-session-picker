import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { resolveSearchConfig } from "./config"
import { elapsedMs, errorFields, logEvent, nextLogID, nowMs, queryStats, timePhase } from "./logging"
import { openSharedSidecar } from "./sidecar"

/** Number of lines of context shown in the preview pane. */
export const PREVIEW_CONTEXT_LINES = 30

export type PreviewLine = {
  text: string
  kind: "role" | "text" | "separator"
  isMatch: boolean
}

export type SessionPreview = {
  sessionID: string
  lines: PreviewLine[]
  matchCount: number
  totalLines: number
}

const IMAGE_DATA_URL_START = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s]+)*;base64,/i

export function sanitizePreviewTextLines(text: string): string[] {
  const lines: string[] = []
  let skippingImagePayload = false

  for (let line of text.split("\n")) {
    if (skippingImagePayload) {
      const trimmed = line.trim()
      if (isBase64Continuation(trimmed)) continue

      const prefix = line.match(/^\s*[A-Za-z0-9+/=]{16,}/)?.[0]
      if (prefix) line = line.slice(prefix.length)
      skippingImagePayload = false
      if (!line.trim()) continue
    }

    let normalized = line
    let imageStart = findImageDataUrlStart(normalized)
    while (imageStart) {
      const payloadStart = imageStart.index + imageStart.marker.length
      const payload = normalized.slice(payloadStart).match(/^[A-Za-z0-9+/=]*/)?.[0] ?? ""
      const before = normalized.slice(0, imageStart.index)
      const after = normalized.slice(payloadStart + payload.length)
      normalized = `${before}[image]${after}`
      skippingImagePayload = after.trim().length === 0

      const searchFrom = before.length + "[image]".length
      imageStart = findImageDataUrlStart(normalized, searchFrom)
    }

    lines.push(normalized)
  }

  return lines
}

function isBase64Continuation(line: string) {
  return line.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(line)
}

function findImageDataUrlStart(text: string, offset = 0) {
  const match = text.slice(offset).match(IMAGE_DATA_URL_START)
  if (match?.index === undefined) return
  return { index: offset + match.index, marker: match[0] }
}

export async function loadSessionPreview(
  api: TuiPluginApi,
  sessionID: string,
  query: string,
  contextLines: number = PREVIEW_CONTEXT_LINES,
): Promise<SessionPreview | undefined> {
  const previewID = nextLogID("preview")
  const started = nowMs()
  const phases: Record<string, number> = {}
  const config = resolveSearchConfig()
  let rawLines: PreviewLine[] | undefined
  let source: "sidecar" | "state" | "api" | "none" = "none"

  logEvent(api, "debug", "preview.started", {
    component: "preview",
    previewID,
    ...queryStats(query),
    contextLines,
  })

  try {
    await timePhase(phases, "sidecarPreviewMs", async () => {
      const sidecar = await openSharedSidecar(config)
      if (sidecar.hasDocuments()) {
        const rows = sidecar.getSessionDocumentTexts(sessionID)
        if (rows.length) {
          rawLines = rowsToLines(rows)
          source = "sidecar"
        }
      }
    })
  } catch (err) {
    logEvent(api, "debug", "preview.sidecar_unavailable", {
      component: "preview",
      previewID,
      ...errorFields(err),
    })
    /* sidecar unavailable */
  }

  if (!rawLines) {
    rawLines = await timePhase(phases, "statePreviewMs", async () => linesFromSyncedState(api, sessionID))
    if (rawLines?.length) source = "state"
  }

  if (!rawLines) {
    rawLines = await timePhase(phases, "apiPreviewMs", () => linesFromApi(api, sessionID))
    if (rawLines?.length) source = "api"
  }
  if (!rawLines?.length) {
    logEvent(api, "warn", "preview.failed", {
      component: "preview",
      previewID,
      ...queryStats(query),
      durationMs: elapsedMs(started),
      phases,
      source,
      reason: "No preview lines were available.",
    })
    return undefined
  }

  const result = applyWindow(sessionID, rawLines, query, contextLines)
  logEvent(api, "debug", "preview.loaded", {
    component: "preview",
    previewID,
    ...queryStats(query),
    durationMs: elapsedMs(started),
    phases,
    source,
    totalLines: result.totalLines,
    visibleLines: result.lines.length,
    matchCount: result.matchCount,
  })
  return result
}

function rowsToLines(rows: Array<{ role: string | null; text: string }>): PreviewLine[] {
  const out: PreviewLine[] = []
  for (const row of rows) {
    out.push({ text: row.role ? `[${row.role}]` : "[title]", kind: "role", isMatch: false })
    for (const l of sanitizePreviewTextLines(row.text.trim())) out.push({ text: l, kind: "text", isMatch: false })
    out.push({ text: "", kind: "separator", isMatch: false })
  }
  return out
}

function linesFromMessages(messages: Message[], partsForMessage: (messageID: string) => readonly Part[]): PreviewLine[] {
  const out: PreviewLine[] = []
  const sorted = [...messages].sort((a, b) => a.time.created - b.time.created)
  for (const msg of sorted) {
    out.push({ text: `[${msg.role}]`, kind: "role", isMatch: false })
    for (const part of partsForMessage(msg.id)) {
      if (part.type === "text" && !part.ignored) {
        for (const l of sanitizePreviewTextLines(part.text)) out.push({ text: l, kind: "text", isMatch: false })
      }
    }
    out.push({ text: "", kind: "separator", isMatch: false })
  }
  return out.length > 1 ? out : []
}

export async function linesFromSyncedState(api: TuiPluginApi, sessionID: string): Promise<PreviewLine[] | undefined> {
  try {
    if (!api.state.ready) return undefined
    const messages = api.state.session.messages(sessionID)
    if (!messages.length) return undefined
    const lines = linesFromMessages([...messages], (messageID) => api.state.part(messageID))
    return lines.length ? lines : undefined
  } catch {
    return undefined
  }
}

function applyWindow(
  sessionID: string,
  all: PreviewLine[],
  query: string,
  contextLines: number,
): SessionPreview {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  let matchCount = 0

  if (terms.length) {
    for (const line of all) {
      if (line.kind === "text" && terms.some((t) => line.text.toLowerCase().includes(t))) {
        line.isMatch = true
        matchCount++
      }
    }
  }

  if (matchCount > 0) {
    const first = all.findIndex((l) => l.isMatch)
    const start = first
    const end = Math.min(all.length, start + contextLines)
    return { sessionID, lines: all.slice(start, end), matchCount, totalLines: all.length }
  }

  return { sessionID, lines: all.slice(0, contextLines), matchCount: 0, totalLines: all.length }
}

async function linesFromApi(api: TuiPluginApi, sessionID: string): Promise<PreviewLine[] | undefined> {
  try {
    const res = await api.client.session.messages({ sessionID })
    if (res.error || !res.data) return undefined
    const messages = res.data.map((entry) => entry.info)
    const partsByMessage = new Map(res.data.map((entry) => [entry.info.id, entry.parts]))
    const lines = linesFromMessages(messages, (messageID) => partsByMessage.get(messageID) ?? [])
    return lines.length ? lines : undefined
  } catch {
    return undefined
  }
}
