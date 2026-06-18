import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Part } from "@opencode-ai/sdk/v2"
import type { SearchConfig, SourceSessionCorpus } from "../../src/search/types"
import { resolveSourceDbPath } from "../../src/search/config"
import { checkFzf } from "../../src/search/dependencies"
import { LlamaEmbeddingClient } from "../../src/search/embedding"
import { runFzfSearch } from "../../src/search/fzf"
import { blendHybridScores } from "../../src/search/ranking"
import { registerSearchIndexInvalidation, searchIndexDebugState } from "../../src/search/search"
import { SIDECAR_SCHEMA_VERSION, SearchSidecar } from "../../src/search/sidecar"
import { readSourceCorpusFromDb } from "../../src/search/source-db"
import { checkSearchEnvironment } from "../../src/search/status"

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function serveOnAvailablePort(fetch: (request: Request) => Response | Promise<Response>) {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 20_000)
    try {
      return Bun.serve({ port, fetch })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function tempPath(name: string) {
  return path.join(await mkdtemp(path.join(tmpdir(), "opencode-smart-picker-")), name)
}

function config(searchDbPath: string, extra: Partial<SearchConfig> = {}): SearchConfig {
  return {
    mode: "hybrid",
    alpha: 0.5,
    searchDbPath,
    embedBaseUrl: "http://127.0.0.1:8081",
    disableVector: true,
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    ...extra,
  }
}

function createSourceDb(file: string) {
  const db = new Database(file)
  db.exec(`
    create table session(
      id text primary key,
      slug text not null,
      project_id text not null,
      workspace_id text,
      parent_id text,
      directory text not null,
      path text,
      title text not null,
      time_created integer not null,
      time_updated integer not null,
      time_archived integer
    );
    create table message(
      id text primary key,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
    create table part(
      id text primary key,
      message_id text not null,
      session_id text not null,
      time_created integer not null,
      time_updated integer not null,
      data text not null
    );
  `)
  const insertSession = db.prepare(`
    insert into session(id, slug, project_id, directory, path, title, time_created, time_updated)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMessage = db.prepare(`
    insert into message(id, session_id, time_created, time_updated, data)
    values (?, ?, ?, ?, ?)
  `)
  const insertPart = db.prepare(`
    insert into part(id, message_id, session_id, time_created, time_updated, data)
    values (?, ?, ?, ?, ?, ?)
  `)

  insertSession.run("ses_one", "one", "proj", "/repo", "packages/app", "Boring title", 1, 10)
  insertMessage.run(
    "msg_one",
    "ses_one",
    2,
    2,
    JSON.stringify({ role: "user", agent: "build", model: { providerID: "local", modelID: "test" } }),
  )
  insertPart.run(
    "prt_one",
    "msg_one",
    "ses_one",
    3,
    3,
    JSON.stringify({ type: "text", text: "Investigate subsetgeneratefamilies regression in semantic ranking" }),
  )
  insertPart.run(
    "prt_one_later",
    "msg_one",
    "ses_one",
    4,
    4,
    JSON.stringify({ type: "text", text: "Later attachment mention: resume.pdf should stay searchable" }),
  )
  insertPart.run(
    "prt_one_image",
    "msg_one",
    "ses_one",
    5,
    5,
    JSON.stringify({
      type: "file",
      filename: "clipboard",
      mime: "image/png",
      url: "data:image/png;base64,base64payloadtoken",
    }),
  )
  insertMessage.run(
    "msg_one_assistant",
    "ses_one",
    6,
    6,
    JSON.stringify({ role: "assistant", agent: "build", model: { providerID: "local", modelID: "test" } }),
  )
  insertPart.run(
    "prt_one_assistant_text",
    "msg_one_assistant",
    "ses_one",
    7,
    7,
    JSON.stringify({ type: "text", text: "assistant-only-token should not be searchable" }),
  )
  insertPart.run(
    "prt_one_assistant_tool",
    "msg_one_assistant",
    "ses_one",
    8,
    8,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      state: { status: "completed", title: "tool-only-token", output: "tool output should not be searchable" },
    }),
  )

  insertSession.run("ses_two", "two", "proj", "/repo", "packages/cli", "Another title", 1, 9)
  insertMessage.run(
    "msg_two",
    "ses_two",
    2,
    2,
    JSON.stringify({ role: "user", agent: "build", model: { providerID: "local", modelID: "test" } }),
  )
  insertPart.run("prt_two", "msg_two", "ses_two", 3, 3, JSON.stringify({ type: "text", text: "Unrelated terminal cleanup" }))

  db.close()
}

describe("search integration", () => {
  test("invalidates the search index from upstream TUI session/message events", () => {
    const handlers = new Map<string, Array<(event: { type: string }) => void>>()
    let lifecycleDisposer: (() => void) | undefined
    const api = {
      event: {
        on(type: string, handler: (event: { type: string }) => void) {
          handlers.set(type, [...(handlers.get(type) ?? []), handler])
          return () => {
            handlers.set(
              type,
              (handlers.get(type) ?? []).filter((item) => item !== handler),
            )
          }
        },
      },
      lifecycle: {
        onDispose(fn: () => void) {
          lifecycleDisposer = fn
          return () => {
            if (lifecycleDisposer === fn) lifecycleDisposer = undefined
          }
        },
      },
      client: {
        app: {
          log: async () => ({}),
        },
      },
    } as unknown as TuiPluginApi

    const before = searchIndexDebugState().generation
    const dispose = registerSearchIndexInvalidation(api)
    handlers.get("message.updated")?.[0]?.({ type: "message.updated" })
    handlers.get("message.part.removed")?.[0]?.({ type: "message.part.removed" })

    expect(searchIndexDebugState().generation).toBe(before + 2)

    dispose()
    handlers.get("session.deleted")?.[0]?.({ type: "session.deleted" })
    expect(searchIndexDebugState().generation).toBe(before + 2)

    lifecycleDisposer?.()
    expect([...handlers.values()].every((list) => list.length === 0)).toBe(true)
  })

  test("resolves OpenCode channel database paths from a real XDG data directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-smart-picker-xdg-"))
    const dataHome = path.join(root, "data")
    const opencodeData = path.join(dataHome, "opencode")
    const localDb = path.join(opencodeData, "opencode-local.db")
    await mkdir(opencodeData, { recursive: true })
    await writeFile(localDb, "")

    expect(resolveSourceDbPath({ XDG_DATA_HOME: dataHome, OPENCODE_CHANNEL: "local" })).toBe(localDb)
    expect(resolveSourceDbPath({ XDG_DATA_HOME: dataHome })).toBe(localDb)
    expect(
      resolveSourceDbPath({
        XDG_DATA_HOME: dataHome,
        OPENCODE_CHANNEL: "local",
        OPENCODE_DISABLE_CHANNEL_DB: "true",
      }),
    ).toBe(path.join(opencodeData, "opencode.db"))
  })

  test("reads an OpenCode-shaped SQLite source DB and searches real sidecar FTS rows", async () => {
    const sourceDb = await tempPath("opencode.db")
    const searchDb = await tempPath("opencode-search.db")
    createSourceDb(sourceDb)

    const corpus = readSourceCorpusFromDb(sourceDb)
    expect(corpus.map((entry) => entry.session.id)).toEqual(["ses_one", "ses_two"])

    const sidecar = await SearchSidecar.open(config(searchDb))
    sidecar.rebuildCorpus(corpus)
    const results = sidecar.searchFts("subsetgeneratefamilies")
    const assistantResults = sidecar.searchFts("assistant-only-token")
    const toolResults = sidecar.searchFts("tool-only-token")
    const titleResults = sidecar.searchFts("Boring")
    const pathResults = sidecar.searchFts("packages")
    const dataUrlResults = sidecar.searchFts("base64payloadtoken")
    const fileNameResults = sidecar.searchFts("clipboard")
    const snippets = sidecar.snippetsForSessions(["ses_one"])
    const needsCurrentReindex = sidecar.needsReindex(corpus.map((entry) => entry.session))
    const needsMissingReindex = sidecar.needsReindex([
      ...corpus.map((entry) => entry.session),
      {
        id: "ses_missing",
        slug: "missing",
        projectID: "proj",
        version: "test",
        directory: "/repo",
        title: "Missing",
        time: { created: 1, updated: 2 },
      },
    ])
    sidecar.close()

    expect(results[0]?.sessionID).toBe("ses_one")
    expect(assistantResults).toEqual([])
    expect(toolResults).toEqual([])
    expect(titleResults[0]?.sessionID).toBe("ses_one")
    expect(pathResults).toEqual([])
    expect(dataUrlResults).toEqual([])
    expect(fileNameResults[0]?.sessionID).toBe("ses_one")
    expect(snippets.get("ses_one")).toContain("Boring title")
    expect(snippets.get("ses_one")).toContain("resume.pdf")
    expect(snippets.get("ses_one")).toContain("clipboard")
    expect(snippets.get("ses_one")).not.toContain("base64payloadtoken")
    expect(snippets.get("ses_one")).not.toContain("assistant-only-token")
    expect(snippets.get("ses_one")).not.toContain("tool-only-token")
    expect(needsCurrentReindex).toBe(false)
    expect(needsMissingReindex).toBe(true)
  })

  test("rebuilds the same sidecar repeatedly without corrupting the FTS index", async () => {
    const sourceDb = await tempPath("opencode.db")
    const searchDb = await tempPath("opencode-search.db")
    createSourceDb(sourceDb)
    const corpus = readSourceCorpusFromDb(sourceDb)

    // Regression: external-content FTS rows must mirror the content table.
    // Mismatched values previously made the second rebuild throw
    // SQLITE_CORRUPT_VTAB and forced a destructive cache reset.
    const sidecar = await SearchSidecar.open(config(searchDb))
    try {
      sidecar.rebuildCorpus(corpus)
      sidecar.rebuildCorpus(corpus)
      expect(sidecar.searchFts("subsetgeneratefamilies")[0]?.sessionID).toBe("ses_one")
    } finally {
      sidecar.close()
    }

    const reopened = await SearchSidecar.open(config(searchDb))
    try {
      reopened.rebuildCorpus(corpus)
      expect(reopened.searchFts("subsetgeneratefamilies")[0]?.sessionID).toBe("ses_one")
      reopened.db.prepare("insert into document_fts(document_fts) values ('integrity-check')").run()
    } finally {
      reopened.close()
    }
  })

  test("applies incremental session updates and removals through indexDelta", async () => {
    const sourceDb = await tempPath("opencode.db")
    const searchDb = await tempPath("opencode-search.db")
    createSourceDb(sourceDb)
    const corpus = readSourceCorpusFromDb(sourceDb)

    const sidecar = await SearchSidecar.open(config(searchDb))
    try {
      sidecar.rebuildCorpus(corpus)
      expect(sidecar.indexDelta(corpus.map((entry) => entry.session)).kind).toBe("none")

      const two = corpus.find((entry) => entry.session.id === "ses_two")!
      const updatedTwo: SourceSessionCorpus = {
        session: { ...two.session, time: { created: two.session.time.created, updated: 99 } },
        messages: [
          {
            info: two.messages[0]!.info,
            parts: [{ ...two.messages[0]!.parts[0]!, text: "Fresh incremental zebrastripe token" } as Part],
          },
        ],
      }

      const delta = sidecar.indexDelta([corpus[0]!.session, updatedTwo.session])
      expect(delta).toEqual({ kind: "incremental", changed: ["ses_two"], removed: [] })

      sidecar.upsertSessions([updatedTwo], [], false)
      expect(sidecar.searchFts("zebrastripe")[0]?.sessionID).toBe("ses_two")
      expect(sidecar.searchFts("Unrelated")).toEqual([])
      expect(sidecar.indexDelta([corpus[0]!.session, updatedTwo.session]).kind).toBe("none")

      const removalDelta = sidecar.indexDelta([updatedTwo.session])
      expect(removalDelta).toEqual({ kind: "incremental", changed: [], removed: ["ses_one"] })
      sidecar.upsertSessions([], ["ses_one"], false)
      expect(sidecar.searchFts("subsetgeneratefamilies")).toEqual([])
      expect(sidecar.indexDelta([updatedTwo.session]).kind).toBe("none")

      // Row-level FTS deletes against external content must leave a
      // consistent index.
      sidecar.db.prepare("insert into document_fts(document_fts) values ('integrity-check')").run()
    } finally {
      sidecar.close()
    }
  })

  test("does not perpetually reindex sessions that produce no documents", async () => {
    const searchDb = await tempPath("opencode-search.db")
    const sidecar = await SearchSidecar.open(config(searchDb))
    try {
      const bare: SourceSessionCorpus = {
        session: {
          id: "ses_bare",
          slug: "bare",
          projectID: "proj",
          version: "test",
          directory: "/repo",
          title: "",
          time: { created: 1, updated: 5 },
        },
        messages: [],
      }
      sidecar.upsertSessions([bare], [], false)
      expect(sidecar.hasDocuments()).toBe(false)
      expect(sidecar.indexDelta([bare.session]).kind).toBe("none")
    } finally {
      sidecar.close()
    }
  })

  test("preserves vector_state across reopen and marks it stale after rebuilds", async () => {
    const searchDb = await tempPath("opencode-search.db")
    const cfg = config(searchDb, { disableVector: false })

    let sidecar = await SearchSidecar.open(cfg)
    expect(sidecar.getMeta("vector_state")?.value).toBe("unavailable")
    sidecar.setMeta("vector_state", "enabled")
    sidecar.close()

    // Regression: migrate() previously reset vector_state to "unavailable"
    // on every open, killing vector search after the first query.
    sidecar = await SearchSidecar.open(cfg)
    try {
      expect(sidecar.getMeta("vector_state")?.value).toBe("enabled")

      const sourceDb = await tempPath("opencode.db")
      createSourceDb(sourceDb)
      sidecar.rebuildCorpus(readSourceCorpusFromDb(sourceDb))
      expect(sidecar.getMeta("vector_state")?.value).toBe("stale")
    } finally {
      sidecar.close()
    }
  })

  test("resets legacy schema-version sidecar caches on open", async () => {
    const searchDb = await tempPath("opencode-search.db")
    const legacy = new Database(searchDb)
    legacy.exec(`
      create table index_meta(key text primary key, value text not null);
      create table document(rowid integer primary key, doc_id text unique not null, session_id text not null, text text not null);
      create virtual table document_fts using fts5(title, directory, path, role, part_type, text, content='document', content_rowid='rowid');
      insert into index_meta(key, value) values ('schema_version', '1');
    `)
    legacy.close()

    const sidecar = await SearchSidecar.open(config(searchDb))
    try {
      expect(sidecar.getMeta("schema_version")?.value).toBe(SIDECAR_SCHEMA_VERSION)
      expect(sidecar.hasDocuments()).toBe(false)
    } finally {
      sidecar.close()
    }
  })

  test("ranks purely semantic candidates when keyword search has no hits", () => {
    const result = blendHybridScores({
      alpha: 0.5,
      vectorAvailable: true,
      keyword: [],
      vector: [
        { sessionID: "ses_sem_strong", score: 0, vectorScore: 0.9 },
        { sessionID: "ses_sem_weak", score: 0, vectorScore: 0.2 },
      ],
    })

    expect(result.ranked.map((row) => row.sessionID)).toEqual(["ses_sem_strong", "ses_sem_weak"])
    expect(result.ranked[0]!.score).toBeGreaterThan(result.ranked[1]!.score)
    expect(result.diagnostics).toEqual([])
  })

  test("recovers a corrupt plugin-owned sidecar cache", async () => {
    const searchDb = await tempPath("opencode-search.db")
    await writeFile(searchDb, "not sqlite")

    const sidecar = await SearchSidecar.open(config(searchDb))
    try {
      expect(sidecar.hasDocuments()).toBe(false)
      sidecar.replaceDocuments([
        {
          docID: "doc:one",
          sessionID: "ses_one",
          chunkIndex: 0,
          synthetic: true,
          ignored: false,
          text: "Recovered title",
          metadata: {},
          sourceHash: "hash",
        },
      ])
      expect(sidecar.searchFts("Recovered")[0]?.sessionID).toBe("ses_one")
    } finally {
      sidecar.close()
    }
  })

  test("runs fzf mode through an executable and parses NUL-delimited session IDs", async () => {
    const fzf = await tempPath("fake-fzf")
    await writeFile(
      fzf,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("fake-fzf 1.0")
  process.exit(0)
}
const query = args[args.indexOf("--filter") + 1] ?? ""
const input = await new Response(Bun.stdin.stream()).text()
const records = input.includes("\\0") ? input.split("\\0").filter(Boolean) : input.split(/\\n/).filter(Boolean)
const matches = records.filter((record) => record.toLowerCase().includes(query.toLowerCase()))
if (!matches.length) process.exit(1)
const acceptId = args.includes("--accept-nth")
const output = matches.map((record) => acceptId ? record.split("\\t")[0] : record).join(input.includes("\\0") ? "\\0" : "\\n")
process.stdout.write(output + (input.includes("\\0") ? "\\0" : "\\n"))
`,
    )
    await chmod(fzf, 0o755)

    const health = await checkFzf(config(await tempPath("search.db"), { mode: "fzf", fzfBin: fzf }))
    expect(health.state).toBe("available")

    const result = await runFzfSearch({
      bin: fzf,
      query: "semantic",
      candidates: [
        {
          session: {
            id: "ses_one",
            slug: "one",
            projectID: "proj",
            version: "test",
            directory: "/repo",
            title: "Semantic session search",
            time: { created: 1, updated: 2 },
          },
          snippet: "user message mentions semantic lookup",
        },
        {
          session: {
            id: "ses_two",
            slug: "two",
            projectID: "proj",
            version: "test",
            directory: "/repo",
            title: "Other work",
            time: { created: 1, updated: 2 },
          },
        },
        {
          session: {
            id: "ses_three",
            slug: "three",
            projectID: "proj",
            version: "test",
            directory: "/repo",
            title: "Semantic title only",
            time: { created: 1, updated: 2 },
          },
        },
      ],
    })

    expect(result).toEqual({ status: "ok", sessionIDs: ["ses_one", "ses_three"] })
  })

  test("runs installed fzf against real tab-delimited picker candidates", async () => {
    const health = await checkFzf(config(await tempPath("search.db"), { mode: "fzf" }))
    if (health.state !== "available" || !health.bin) {
      console.warn(`skipping installed fzf candidate test: ${health.message ?? health.state}`)
      return
    }

    const result = await runFzfSearch({
      bin: health.bin,
      query: "occurred",
      candidates: [
        {
          session: {
            id: "ses_real_match",
            slug: "real-match",
            projectID: "proj",
            version: "test",
            directory: "/repo",
            title: "Title should not be searched",
            time: { created: 1, updated: 3 },
          },
          snippet: "user text says the error occurred in the polling pipeline",
        },
        {
          session: {
            id: "ses_title_only",
            slug: "title-only",
            projectID: "proj",
            version: "test",
            directory: "/repo",
            title: "occurred only in title",
            time: { created: 1, updated: 2 },
          },
          snippet: "user text talks about a different thing",
        },
      ],
    })

    expect(result).toEqual({ status: "ok", sessionIDs: ["ses_real_match", "ses_title_only"] })
  })

  test("reports TUI search modes and dependency readiness from real local checks", async () => {
    const sourceDb = await tempPath("opencode.db")
    const searchDb = await tempPath("opencode-search.db")
    const fzf = await tempPath("fake-fzf")
    await writeFile(sourceDb, "")
    await writeFile(
      fzf,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("fake-fzf 1.0")
  process.exit(0)
}
const input = await new Response(Bun.stdin.stream()).text()
process.stdout.write(input.split(/\\n/).filter((line) => line.includes("a")).join("\\n") + "\\n")
`,
    )
    await chmod(fzf, 0o755)

    const previous = {
      sourceDb: process.env.OPENCODE_SMART_PICKER_SOURCE_DB,
      searchDb: process.env.OPENCODE_SMART_PICKER_SEARCH_DB,
      fzfBin: process.env.OPENCODE_SMART_PICKER_FZF_BIN,
      disableVector: process.env.OPENCODE_SMART_PICKER_DISABLE_VECTOR,
    }
    process.env.OPENCODE_SMART_PICKER_SOURCE_DB = sourceDb
    process.env.OPENCODE_SMART_PICKER_SEARCH_DB = searchDb
    process.env.OPENCODE_SMART_PICKER_FZF_BIN = fzf
    process.env.OPENCODE_SMART_PICKER_DISABLE_VECTOR = "1"
    try {
      const status = await checkSearchEnvironment({ mode: "fzf" })
      expect(status.mode).toBe("fzf")
      expect(status.modes.find((mode) => mode.mode === "fzf")?.state).toBe("available")
      expect(status.dependencies.find((dependency) => dependency.name === "fzf")?.state).toBe("available")
      expect(status.dependencies.find((dependency) => dependency.name === "llama-server")?.state).toBe("disabled")
      expect(status.dependencies.find((dependency) => dependency.name === "sqlite-vec")?.state).toBe("disabled")
      expect(status.dependencies.find((dependency) => dependency.name === "sidecar index")?.state).toBe("available")
    } finally {
      if (previous.sourceDb === undefined) delete process.env.OPENCODE_SMART_PICKER_SOURCE_DB
      else process.env.OPENCODE_SMART_PICKER_SOURCE_DB = previous.sourceDb
      if (previous.searchDb === undefined) delete process.env.OPENCODE_SMART_PICKER_SEARCH_DB
      else process.env.OPENCODE_SMART_PICKER_SEARCH_DB = previous.searchDb
      if (previous.fzfBin === undefined) delete process.env.OPENCODE_SMART_PICKER_FZF_BIN
      else process.env.OPENCODE_SMART_PICKER_FZF_BIN = previous.fzfBin
      if (previous.disableVector === undefined) delete process.env.OPENCODE_SMART_PICKER_DISABLE_VECTOR
      else process.env.OPENCODE_SMART_PICKER_DISABLE_VECTOR = previous.disableVector
    }
  })

  test("validates llama.cpp-compatible embedding responses from a real local HTTP server", async () => {
    const server = serveOnAvailablePort(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/health" || url.pathname === "/v1/health") {
        return Response.json({ status: "ok" })
      }
      if (url.pathname === "/v1/embeddings") {
        const body = (await request.json()) as { input: string[] }
        return Response.json({
          object: "list",
          model: "fake",
          data: body.input.map((_, index) => ({
            object: "embedding",
            index,
            embedding: [index + 0.1, index + 0.2, index + 0.3],
          })),
        })
      }
      return new Response("not found", { status: 404 })
    })
    servers.push(server)

    const client = new LlamaEmbeddingClient(config(await tempPath("search.db"), { embedBaseUrl: server.url.href }))
    expect(await client.health()).toBe(true)
    expect(Array.from(await client.embedQuery("ranking"))).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ])
  })

  test("blends hybrid alpha scores and degrades to keyword ranking when vectors are unavailable", () => {
    const result = blendHybridScores({
      alpha: 0.8,
      vectorAvailable: false,
      keyword: [
        { sessionID: "ses_keyword", score: 0, keywordScore: 10 },
        { sessionID: "ses_other", score: 0, keywordScore: 1 },
      ],
      vector: [{ sessionID: "ses_vector", score: 0, vectorScore: 100 }],
    })

    expect(result.ranked[0]?.sessionID).toBe("ses_keyword")
    expect(result.diagnostics[0]?.kind).toBe("vector-disabled")
  })
})
