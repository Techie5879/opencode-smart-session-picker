import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { resolveSourceDbPath } from "../../src/search/config"
import { extractSessionDocuments } from "../../src/search/extractor"
import { SearchSidecar } from "../../src/search/sidecar"
import type { SearchConfig, SourceSessionCorpus } from "../../src/search/types"
import { readSourceCorpusFromDb } from "../../src/search/source-db"

const SYNTHETIC_WORKSPACE = "/tmp/opencode-smart-picker-perf-workspace"

type FuzzyCase = {
  query: string
  expectedSessionMatches: number
  expectedPartMentions: number
}

type BenchmarkQuery = {
  label: string
  query: string
}

const syntheticCases: FuzzyCase[] = [
  { query: "firestore", expectedSessionMatches: 360, expectedPartMentions: 2_400 },
  { query: "record_id", expectedSessionMatches: 260, expectedPartMentions: 1_300 },
  { query: "project-alpha-123456", expectedSessionMatches: 180, expectedPartMentions: 1_440 },
  { query: "11111111-2222-4333-8444-555555555555", expectedSessionMatches: 2, expectedPartMentions: 12 },
  { query: "zzzzzzzzzzzzzzzzzzzzzzzz", expectedSessionMatches: 1, expectedPartMentions: 1 },
]

async function tempDb(name: string) {
  return path.join(await mkdtemp(path.join(tmpdir(), "opencode-smart-picker-perf-")), name)
}

function config(searchDbPath: string): SearchConfig {
  return {
    mode: "hybrid",
    alpha: 0.5,
    searchDbPath,
    embedBaseUrl: "http://127.0.0.1:8081",
    disableVector: true,
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  }
}

function syntheticCorpus(cases: FuzzyCase[]): SourceSessionCorpus[] {
  const totalSessions = 420
  const corpus: SourceSessionCorpus[] = []
  for (let index = 0; index < totalSessions; index += 1) {
    const sessionID = `ses_perf_${String(index).padStart(4, "0")}`
    const session: Session = {
      id: sessionID,
      slug: sessionID,
      projectID: "perf-project",
      version: "test",
      directory: SYNTHETIC_WORKSPACE,
      title: `Performance fixture ${index}`,
      time: { created: index, updated: 10_000 + index },
    }
    const messages: SourceSessionCorpus["messages"] = []
    for (const [caseIndex, item] of cases.entries()) {
      if (index >= item.expectedSessionMatches) continue
      const parts: Part[] = []
      const mentions = Math.max(1, Math.floor(item.expectedPartMentions / item.expectedSessionMatches))
      for (let mention = 0; mention < mentions; mention += 1) {
        parts.push({
          id: `prt_${caseIndex}_${mention}`,
          sessionID,
          messageID: `msg_${caseIndex}`,
          type: "text",
          text: `OpenCode benchmark ${item.query} Firestore record behavior ${mention}`,
        } as Part)
      }
      messages.push({
        info: {
          id: `msg_${caseIndex}`,
          sessionID,
          role: "user",
          time: { created: caseIndex },
        } as Message,
        parts,
      })
    }
    if (!messages.length) {
      messages.push({
        info: { id: "msg_control", sessionID, role: "user", time: { created: 0 } } as Message,
        parts: [
          {
            id: "prt_control",
            sessionID,
            messageID: "msg_control",
            type: "text",
            text: "control conversation with unrelated terminal cleanup",
          } as Part,
        ],
      })
    }
    corpus.push({ session, messages })
  }
  return corpus
}

function textForTokenSampling(corpus: SourceSessionCorpus[]) {
  return corpus.map((entry) => ({
    sessionID: entry.session.id,
    text: extractSessionDocuments(entry.session, entry.messages)
      .map((document) => document.text)
      .join("\n"),
  }))
}

function discoverLiveBenchmarkQueries(corpus: SourceSessionCorpus[]): BenchmarkQuery[] {
  const byToken = new Map<string, { sessions: Set<string>; mentions: number }>()
  const stopWords = new Set([
    "assistant",
    "directory",
    "master",
    "opencode",
    "prompt",
    "role",
    "session",
    "text",
    "title",
    "users",
  ])
  for (const entry of textForTokenSampling(corpus)) {
    const seenInSession = new Set<string>()
    for (const match of entry.text.matchAll(/[A-Za-z0-9]{6,80}/g)) {
      const token = match[0]
      const key = token.toLowerCase()
      if (stopWords.has(key) || /^gA{4,}/i.test(token) || /^ses/.test(key) || /^msg/.test(key) || /^prt/.test(key)) {
        continue
      }
      const stat = byToken.get(key) ?? { sessions: new Set<string>(), mentions: 0 }
      stat.mentions += 1
      if (!seenInSession.has(key)) {
        stat.sessions.add(entry.sessionID)
        seenInSession.add(key)
      }
      byToken.set(key, stat)
    }
  }

  const rows = [...byToken.entries()].map(([query, stat]) => ({
    query,
    sessions: stat.sessions.size,
    mentions: stat.mentions,
  }))
  const highHit = rows
    .filter((row) => row.sessions >= Math.max(20, corpus.length * 0.2))
    .sort((a, b) => b.sessions - a.sessions || b.mentions - a.mentions)
    .slice(0, 4)
  const lowHit = rows
    .filter((row) => row.sessions <= 2 && row.mentions <= 10 && row.query.length >= 12)
    .sort((a, b) => a.sessions - b.sessions || a.mentions - b.mentions || b.query.length - a.query.length)
    .slice(0, 4)

  return [
    ...highHit.map((row, index) => ({ label: `live-high-hit-${index + 1}`, query: row.query })),
    ...lowHit.map((row, index) => ({ label: `live-low-hit-${index + 1}`, query: row.query })),
  ]
}

async function benchmarkCorpus(label: string, corpus: SourceSessionCorpus[], queries: BenchmarkQuery[]) {
  const sidecar = await SearchSidecar.open(config(await tempDb(`${label}.db`)))
  try {
    const rebuildStarted = performance.now()
    sidecar.rebuildCorpus(corpus)
    const rebuildMs = performance.now() - rebuildStarted

    const results = queries.map(({ label: queryLabel, query }) => {
      const started = performance.now()
      const matches = sidecar.searchFts(query)
      return {
        label: queryLabel,
        matches: matches.length,
        durationMs: performance.now() - started,
      }
    })

    console.info(
      JSON.stringify({
        label,
        sessions: corpus.length,
        rebuildMs: Math.round(rebuildMs),
        queries: results.map((result) => ({
          ...result,
          durationMs: Number(result.durationMs.toFixed(2)),
        })),
      }),
    )

    return { rebuildMs, results }
  } finally {
    sidecar.close()
  }
}

describe("fuzzy search performance", () => {
  test("keeps deterministic heavy and rare keyword FTS searches bounded", async () => {
    const corpus = syntheticCorpus(syntheticCases)
    const { results } = await benchmarkCorpus(
      "synthetic-busy-workspace",
      corpus,
      syntheticCases.map((item) => ({ label: item.query, query: item.query })),
    )

    const maxQueryMs = Number(process.env.OPENCODE_SMART_PICKER_SYNTHETIC_FUZZY_MAX_MS ?? 150)
    for (const result of results) {
      expect(result.matches).toBeGreaterThan(0)
      expect(result.durationMs).toBeLessThan(maxQueryMs)
    }
  })

  const liveWorkspace = process.env.OPENCODE_SMART_PICKER_PERF_WORKSPACE
  const liveTest = process.env.OPENCODE_SMART_PICKER_LIVE_PERF === "1" && liveWorkspace ? test : test.skip
  liveTest(
    "measures live local OpenCode fuzzy search behavior",
    async () => {
      const sourceDb = process.env.OPENCODE_SMART_PICKER_SOURCE_DB ?? resolveSourceDbPath()
      const corpus = readSourceCorpusFromDb(sourceDb, {
        directory: liveWorkspace,
      })
      expect(corpus.length).toBeGreaterThan(0)

      const liveQueries = discoverLiveBenchmarkQueries(corpus)
      expect(liveQueries.length).toBeGreaterThanOrEqual(2)

      const { results } = await benchmarkCorpus("live-local-workspace", corpus, liveQueries)
      const maxQueryMs = Number(process.env.OPENCODE_SMART_PICKER_LIVE_FUZZY_MAX_MS ?? 1_000)
      for (const result of results) {
        expect(result.durationMs).toBeLessThan(maxQueryMs)
      }
    },
    30_000,
  )
})
