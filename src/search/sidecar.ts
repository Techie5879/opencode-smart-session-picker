import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import type { RankedCandidate, SearchConfig, SearchDocument, SourceSessionCorpus } from "./types"
import { extractSessionDocuments } from "./extractor"
import { fileExists } from "./config"

let customSQLiteAttempted = false

function now() {
  return Date.now()
}

async function candidateSQLiteLibraries(config: SearchConfig) {
  return [
    config.sqliteLibPath,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ].filter((file): file is string => Boolean(file))
}

async function configureSQLiteForExtensions(config: SearchConfig) {
  if (customSQLiteAttempted || config.disableVector) return
  customSQLiteAttempted = true

  for (const candidate of await candidateSQLiteLibraries(config)) {
    if (!(await fileExists(candidate))) continue
    try {
      if (Database.setCustomSQLite(candidate)) return
    } catch {
      return
    }
  }
}

function ftsQuery(query: string) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*^:()]/g, " ").trim())
    .filter(Boolean)
  if (!tokens.length) return ""
  return tokens.map((token) => `"${token}"*`).join(" AND ")
}

function normalizeScores<T extends { raw: number }>(rows: T[]) {
  if (!rows.length) return new Map<T, number>()
  const values = rows.map((row) => row.raw)
  const min = Math.min(...values)
  const max = Math.max(...values)
  return new Map(rows.map((row) => [row, max === min ? 1 : (row.raw - min) / (max - min)]))
}

export class SearchSidecar {
  readonly db: Database
  private vectorExtensionLoaded = false

  constructor(readonly config: SearchConfig) {
    this.db = new Database(config.searchDbPath)
  }

  static async open(config: SearchConfig) {
    await mkdir(path.dirname(config.searchDbPath), { recursive: true })
    await configureSQLiteForExtensions(config)
    const sidecar = new SearchSidecar(config)
    sidecar.migrate()
    return sidecar
  }

  close() {
    this.db.close()
  }

  migrate() {
    this.db.exec(`
      create table if not exists index_meta(
        key text primary key,
        value text not null
      );

      create table if not exists source_state(
        source_db_fingerprint text not null,
        last_full_reconcile integer,
        checked_at integer not null
      );

      create table if not exists indexed_session(
        session_id text primary key,
        parent_id text,
        project_id text,
        workspace_id text,
        directory text,
        path text,
        source_hash text not null,
        indexed_at integer not null
      );

      create table if not exists document(
        rowid integer primary key,
        doc_id text unique not null,
        session_id text not null,
        message_id text,
        part_id text,
        chunk_index integer not null,
        role text,
        part_type text,
        synthetic integer not null,
        ignored integer not null,
        title text,
        directory text,
        path text,
        text text not null,
        metadata_json text not null,
        source_hash text not null,
        extractor_version text not null,
        indexed_at integer not null
      );

      create virtual table if not exists document_fts using fts5(
        title,
        directory,
        path,
        role,
        part_type,
        text,
        content='document',
        content_rowid='rowid'
      );
    `)

    this.ensureColumn("document", "title", "text")
    this.ensureColumn("document", "directory", "text")
    this.ensureColumn("document", "path", "text")

    this.setMeta("schema_version", "1")
    this.setMeta("extractor_version", "1")
    this.setMeta("ranking_version", "1")
    this.setMeta("supported_search_modes", "hybrid")
    this.setMeta("vector_state", this.config.disableVector ? "disabled" : "unavailable")
    this.setMeta("document_prefix", this.config.documentPrefix)
    this.setMeta("query_prefix", this.config.queryPrefix)
    this.setMeta("embedding_base_url", this.config.embedBaseUrl)
    if (this.config.embedModel) this.setMeta("embedding_model", this.config.embedModel)
  }

  private ensureColumn(table: string, column: string, declaration: string) {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>
    if (rows.some((row) => row.name === column)) return
    this.db.exec(`alter table ${table} add column ${column} ${declaration}`)
  }

  getMeta(key: string) {
    return this.db.prepare("select value from index_meta where key = ?").get(key) as { value: string } | undefined
  }

  setMeta(key: string, value: string) {
    this.db.prepare(`
      insert into index_meta(key, value)
      values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, value)
  }

  async loadVectorExtension() {
    if (this.vectorExtensionLoaded) return true
    if (this.config.disableVector) {
      this.setMeta("vector_state", "disabled")
      return false
    }

    try {
      if (this.config.sqliteVecExtension && (await fileExists(this.config.sqliteVecExtension))) {
        this.db.loadExtension(this.config.sqliteVecExtension)
        this.vectorExtensionLoaded = true
        return true
      }

      const importPackage = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<{ load?: (db: Database) => void }>
      const sqliteVec = await importPackage("sqlite-vec").catch(() => undefined)
      if (sqliteVec?.load) {
        sqliteVec.load(this.db)
        this.vectorExtensionLoaded = true
        return true
      }

      const devExtension = path.resolve(process.cwd(), "upstream", "sqlite-vec", "dist", "vec0")
      if (await fileExists(devExtension)) {
        this.db.loadExtension(devExtension)
        this.vectorExtensionLoaded = true
        return true
      }
    } catch {
      this.setMeta("vector_state", "unavailable")
      return false
    }

    this.setMeta("vector_state", "unavailable")
    return false
  }

  async replaceVectorEmbeddings(documents: SearchDocument[], embeddings: Float32Array[]) {
    if (!documents.length || documents.length !== embeddings.length) return false
    if (!(await this.loadVectorExtension())) return false

    const dimensions = embeddings[0]?.length
    if (!dimensions) return false

    this.db.exec(`create virtual table if not exists document_vec using vec0(embedding float[${dimensions}])`)
    const selectRowID = this.db.prepare("select rowid from document where doc_id = ?")
    const insert = this.db.prepare("insert into document_vec(rowid, embedding) values (?, vec_f32(?))")
    const transaction = this.db.transaction(() => {
      this.db.prepare("delete from document_vec").run()
      for (const [index, document] of documents.entries()) {
        const row = selectRowID.get(document.docID) as { rowid: number } | undefined
        if (!row) continue
        insert.run(row.rowid, embeddings[index])
      }
      this.setMeta("embedding_dimensions", String(dimensions))
      this.setMeta("vector_state", "enabled")
    })
    transaction()
    return true
  }

  async searchVector(queryEmbedding: Float32Array): Promise<RankedCandidate[]> {
    if (!(await this.loadVectorExtension())) return []
    const state = this.getMeta("vector_state")?.value
    if (state !== "enabled") return []
    const count = (this.db.prepare("select count(*) as count from document_vec").get() as { count: number }).count
    if (!count) return []

    const rows = this.db
      .prepare(`
        select d.session_id as sessionID, v.distance as distance
        from document_vec v
        join document d on d.rowid = v.rowid
        where v.embedding match vec_f32(?) and k = ?
        order by distance asc
      `)
      .all(queryEmbedding, count) as Array<{
      sessionID: string
      distance: number
    }>

    const bestBySession = new Map<string, { sessionID: string; distance: number }>()
    for (const row of rows) {
      const current = bestBySession.get(row.sessionID)
      if (!current || row.distance < current.distance) bestBySession.set(row.sessionID, row)
    }

    const raw = [...bestBySession.values()].map((row) => ({ ...row, raw: -row.distance }))
    const normalized = normalizeScores(raw)
    return raw.map((row) => ({
      sessionID: row.sessionID,
      score: normalized.get(row) ?? 0,
      vectorScore: normalized.get(row) ?? 0,
    }))
  }

  hasDocuments() {
    const row = this.db.prepare("select exists(select 1 from document) as found").get() as { found: number }
    return row.found === 1
  }

  needsReindex(sessions: Array<{ id: string; time?: { updated: number } }>) {
    if (!this.hasDocuments()) return true
    if (!sessions.length) return false

    const placeholders = sessions.map(() => "?").join(",")
    const indexed = this.db
      .prepare(`select count(distinct session_id) as count from indexed_session where session_id in (${placeholders})`)
      .get(...sessions.map((session) => session.id)) as { count: number }
    if (indexed.count < sessions.length) return true

    const lastIndexed = Number(this.getMeta("last_indexed_at")?.value ?? 0)
    const latestSessionUpdate = Math.max(...sessions.map((session) => session.time?.updated ?? 0))
    return Number.isFinite(latestSessionUpdate) && latestSessionUpdate > lastIndexed
  }

  rebuildCorpus(corpus: SourceSessionCorpus[]) {
    const documents = corpus.flatMap((entry) => extractSessionDocuments(entry.session, entry.messages))
    this.replaceDocuments(documents)

    const indexedAt = now()
    const insertSession = this.db.prepare(`
      insert into indexed_session(session_id, parent_id, project_id, workspace_id, directory, path, source_hash, indexed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(session_id) do update set
        parent_id = excluded.parent_id,
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        directory = excluded.directory,
        path = excluded.path,
        source_hash = excluded.source_hash,
        indexed_at = excluded.indexed_at
    `)
    const transaction = this.db.transaction(() => {
      for (const entry of corpus) {
        insertSession.run(
          entry.session.id,
          entry.session.parentID ?? null,
          entry.session.projectID,
          entry.session.workspaceID ?? null,
          entry.session.directory,
          entry.session.path ?? null,
          documents
            .filter((document) => document.sessionID === entry.session.id)
            .map((document) => document.sourceHash)
            .join(":") || entry.session.id,
          indexedAt,
        )
      }
      this.db.prepare("delete from indexed_session where session_id not in (select distinct session_id from document)").run()
    })
    transaction()
  }

  replaceDocuments(documents: SearchDocument[]) {
    const clear = this.db.prepare("delete from document")
    const clearFts = this.db.prepare("delete from document_fts")
    const insertDocument = this.db.prepare(`
      insert into document(
        doc_id, session_id, message_id, part_id, chunk_index, role, part_type,
        synthetic, ignored, title, directory, path, text, metadata_json, source_hash, extractor_version, indexed_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.db.prepare(`
      insert into document_fts(rowid, title, directory, path, role, part_type, text)
      values (?, ?, ?, ?, ?, ?, ?)
    `)
    const transaction = this.db.transaction(() => {
      clearFts.run()
      clear.run()
      for (const document of documents) {
        const metadata = document.metadata
        const title = typeof metadata.title === "string" ? metadata.title : ""
        const directory = typeof metadata.directory === "string" ? metadata.directory : ""
        const documentPath = typeof metadata.path === "string" ? metadata.path : ""
        const result = insertDocument.run(
          document.docID,
          document.sessionID,
          document.messageID ?? null,
          document.partID ?? null,
          document.chunkIndex,
          document.role ?? null,
          document.partType ?? null,
          document.synthetic ? 1 : 0,
          document.ignored ? 1 : 0,
          title,
          directory,
          documentPath,
          document.text,
          JSON.stringify(document.metadata),
          document.sourceHash,
          "1",
          now(),
        )
        insertFts.run(
          result.lastInsertRowid,
          title,
          directory,
          documentPath,
          document.role ?? "",
          document.partType ?? "",
          document.text,
        )
      }
      this.setMeta("last_indexed_at", String(now()))
    })
    transaction()
  }

  searchFts(query: string): RankedCandidate[] {
    const match = ftsQuery(query)
    if (!match) return []
    const rows = this.db
      .prepare(`
        select
          d.session_id as sessionID,
          bm25(document_fts) as rank,
          snippet(document_fts, 5, '[', ']', ' ... ', 12) as snippet
        from document_fts
        join document d on d.rowid = document_fts.rowid
        where document_fts match ?
        order by rank asc
      `)
      .all(match) as Array<{ sessionID: string; rank: number; snippet?: string }>

    const bestBySession = new Map<string, { sessionID: string; rank: number; snippet?: string }>()
    for (const row of rows) {
      const current = bestBySession.get(row.sessionID)
      if (!current || row.rank < current.rank) bestBySession.set(row.sessionID, row)
    }

    const keywordRows = [...bestBySession.values()].map((row) => ({ ...row, raw: -row.rank }))
    const normalized = normalizeScores(keywordRows)
    return keywordRows.map((row) => ({
      sessionID: row.sessionID,
      score: normalized.get(row) ?? 0,
      keywordScore: normalized.get(row) ?? 0,
      snippet: row.snippet,
    }))
  }

  getSessionDocumentTexts(sessionID: string): Array<{ role: string | null; text: string }> {
    return this.db
      .prepare("select role, text from document where session_id = ? order by rowid asc")
      .all(sessionID) as Array<{ role: string | null; text: string }>
  }

  snippetsForSessions(sessionIDs: string[]) {
    if (!sessionIDs.length) return new Map<string, string>()
    const placeholders = sessionIDs.map(() => "?").join(",")
    const rows = this.db
      .prepare(`
        select session_id as sessionID, group_concat(text, ' ') as snippet
        from document
        where session_id in (${placeholders})
        group by session_id
      `)
      .all(...sessionIDs) as Array<{ sessionID: string; snippet: string }>
    return new Map(rows.map((row) => [row.sessionID, row.snippet]))
  }
}
