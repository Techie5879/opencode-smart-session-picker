import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { resolveSearchConfig } from "./config"
import { elapsedMs, errorFields, logEvent, nextLogID, nowMs, queryStats, timePhase } from "./logging"
import { openSharedSidecar } from "./sidecar"

/** Number of lines of context shown in the preview pane. */
export const PREVIEW_CONTEXT_LINES = 30

export type PreviewLine = {
  text: string
  kind: "role" | "title" | "text" | "attachment" | "separator"
  isMatch: boolean
  highlights?: Array<{ start: number; end: number }>
  attachment?: {
    badge: string
    label: string
    mime?: string
  }
}

export type SessionPreview = {
  sessionID: string
  lines: PreviewLine[]
  matchCount: number
  totalLines: number
}

const IMAGE_DATA_URL_START = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s]+)*;base64,/i

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

type PreviewDocumentRow = {
  messageID: string | null
  partID?: string | null
  role: string | null
  partType: string | null
  text: string
  metadataJson?: string | null
}

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
          rawLines = previewLinesFromDocumentRows(rows)
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

  const result = applyPreviewWindow(sessionID, rawLines, query, contextLines)
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

export function previewLinesFromDocumentRows(rows: PreviewDocumentRow[]): PreviewLine[] {
  const out: PreviewLine[] = []
  let current:
    | {
        messageID: string
        role: string | null
        lines: PreviewLine[]
      }
    | undefined

  function flushMessage() {
    if (!current) return
    if (current.lines.length) {
      out.push({ text: current.role ?? "message", kind: "role", isMatch: false })
      out.push(...current.lines)
      out.push({ text: "", kind: "separator", isMatch: false })
    }
    current = undefined
  }

  for (const row of rows) {
    if (!row.messageID) {
      flushMessage()
      for (const l of sanitizePreviewTextLines(row.text.trim())) out.push({ text: l, kind: "title", isMatch: false })
      out.push({ text: "", kind: "separator", isMatch: false })
      continue
    }

    if (!current || current.messageID !== row.messageID) {
      flushMessage()
      current = { messageID: row.messageID, role: row.role, lines: [] }
    }

    if (row.partType === "file") {
      const attachment = fileAttachment(row)
      current.lines.push({
        text: `${attachment.badge} ${attachment.label}`.trim(),
        kind: "attachment",
        isMatch: false,
        attachment,
      })
    } else {
      for (const l of sanitizePreviewTextLines(row.text.trim())) current.lines.push({ text: l, kind: "text", isMatch: false })
    }
  }
  flushMessage()
  return out
}

function fileAttachment(row: PreviewDocumentRow) {
  const metadata = parseMetadata(row.metadataJson)
  const lines = sanitizePreviewTextLines(row.text.trim())
    .map((line) => line.trim())
    .filter(Boolean)
  const mime = stringValue(metadata.mime) ?? lines.find(isMimeType)
  const label =
    stringValue(metadata.filename) ??
    lines.find((line) => line !== "[image]" && !isMimeType(line) && !line.startsWith("data:")) ??
    mime ??
    "attachment"
  return {
    badge: mime ? MIME_BADGE[mime] ?? mime.split("/").at(-1) ?? "file" : "file",
    label,
    mime,
  }
}

function parseMetadata(value: string | null | undefined) {
  if (!value) return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isMimeType(value: string) {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)
}

function linesFromMessages(messages: Message[], partsForMessage: (messageID: string) => readonly Part[]): PreviewLine[] {
  const out: PreviewLine[] = []
  const sorted = [...messages].sort((a, b) => a.time.created - b.time.created)
  for (const msg of sorted) {
    out.push({ text: msg.role, kind: "role", isMatch: false })
    for (const part of partsForMessage(msg.id)) {
      if (part.type === "text" && !part.ignored) {
        for (const l of sanitizePreviewTextLines(part.text)) out.push({ text: l, kind: "text", isMatch: false })
      }
      if (part.type === "file") {
        const attachment = fileAttachment({
          messageID: msg.id,
          partID: part.id,
          role: msg.role,
          partType: part.type,
          text: [part.filename, part.mime].filter(Boolean).join("\n"),
          metadataJson: JSON.stringify({ filename: part.filename, mime: part.mime }),
        })
        out.push({
          text: `${attachment.badge} ${attachment.label}`.trim(),
          kind: "attachment",
          isMatch: false,
          attachment,
        })
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

export function applyPreviewWindow(
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
      if (line.kind !== "text" && line.kind !== "title" && line.kind !== "attachment") continue

      const highlights = previewHighlights(line.text, terms)
      if (highlights.length) {
        line.isMatch = true
        line.highlights = highlights
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

function previewHighlights(text: string, terms: string[]) {
  const exact = exactHighlights(text, terms)
  if (exact.length) return exact
  return fuzzyHighlights(text, terms)
}

function exactHighlights(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    let from = 0
    while (from < lower.length) {
      const start = lower.indexOf(term, from)
      if (start < 0) break
      ranges.push({ start, end: start + term.length })
      from = start + Math.max(1, term.length)
    }
  }
  return mergeRanges(ranges)
}

function fuzzyHighlights(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    const matched = fuzzyTermHighlights(lower, term)
    if (matched.length) ranges.push(...matched)
  }
  return mergeRanges(ranges)
}

function fuzzyTermHighlights(lower: string, term: string) {
  if (!term) return []
  const ranges: Array<{ start: number; end: number }> = []
  let from = 0
  for (const char of term) {
    const index = lower.indexOf(char, from)
    if (index < 0) return []
    ranges.push({ start: index, end: index + 1 })
    from = index + 1
  }
  return ranges
}

function mergeRanges(input: Array<{ start: number; end: number }>) {
  if (!input.length) return []
  const ranges = input
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
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
