import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import type { SearchConfig } from "../../src/search/types"
import { resolveSourceDbPath } from "../../src/search/config"
import { checkFzf } from "../../src/search/dependencies"
import { LlamaEmbeddingClient } from "../../src/search/embedding"
import { runFzfSearch } from "../../src/search/fzf"
import { blendHybridScores } from "../../src/search/ranking"
import { SearchSidecar } from "../../src/search/sidecar"
import { readSourceCorpusFromDb } from "../../src/search/source-db"
import { checkSearchEnvironment } from "../../src/search/status"

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

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
    sidecar.close()

    expect(results[0]?.sessionID).toBe("ses_one")
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
      ],
    })

    expect(result).toEqual({ status: "ok", sessionIDs: ["ses_one"] })
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
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
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
      },
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
