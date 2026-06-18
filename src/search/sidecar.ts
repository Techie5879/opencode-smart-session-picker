import { mkdir, unlink } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import type { RankedCandidate, SearchConfig, SearchDocument, SourceSessionCorpus } from "./types"
import { SEARCH_EXTRACTOR_VERSION, extractSessionDocuments } from "./extractor"
import { fileExists } from "./config"

/**
 * Bump when the sidecar layout changes incompatibly. A mismatch deletes the
 * plugin-owned cache database and rebuilds it from scratch, which is always
 * safe because the sidecar is a derived index over OpenCode's own data.
 */
export const SIDECAR_SCHEMA_VERSION = "2"

const SQL_VARIABLE_CHUNK = 500

let customSQLiteAttempted = false

function now() {
  return Date.now()
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
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

function isCorruptDatabaseError(error: unknown) {
  return error instanceof Error && /database disk image is malformed|database corruption|file is not a database/i.test(error.message)
}

class SchemaResetRequired extends Error {
  constructor() {
    super("Sidecar schema version mismatch; cache reset required.")
  }
}

async function removeSidecarDatabase(file: string) {
  await Promise.all(
    [file, `${file}-wal`, `${file}-shm`].map((candidate) =>
      unlink(candidate).catch((err) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return
        throw err
      }),
    ),
  )
}

export type SessionIndexDelta =
  | { kind: "none" }
  | { kind: "full"; removed: string[] }
  | { kind: "incremental"; changed: string[]; removed: string[] }

export type VectorEmbeddableDocument = Pick<SearchDocument, "docID" | "text">

export class SearchSidecar {
  readonly db: Database
  private vectorExtensionLoaded = false

  constructor(readonly config: SearchConfig) {
    this.db = new Database(config.searchDbPath)
    this.db.exec("pragma journal_mode = WAL")
    this.db.exec("pragma synchronous = NORMAL")
    this.db.exec("pragma busy_timeout = 2000")
  }

  static async open(config: SearchConfig) {
    await mkdir(path.dirname(config.searchDbPath), { recursive: true })
    await configureSQLiteForExtensions(config)
    return SearchSidecar.openMigrated(config, true)
  }

  static isRecoverableCacheError(error: unknown) {
    return isCorruptDatabaseError(error)
  }

  static async resetCache(config: SearchConfig) {
    if (config.searchDbPath === ":memory:") return
    await removeSidecarDatabase(config.searchDbPath)
  }

  private static async openMigrated(config: SearchConfig, recover: boolean): Promise<SearchSidecar> {
    let sidecar: SearchSidecar | undefined
    try {
      sidecar = new SearchSidecar(config)
      if (sidecar.schemaVersionMismatch()) throw new SchemaResetRequired()
      sidecar.migrate()
      return sidecar
    } catch (err) {
      try {
        sidecar?.close()
      } catch {
        /* ignore close errors while recovering */
      }
      const recoverable = err instanceof SchemaResetRequired || isCorruptDatabaseError(err)
      if (!recover || !recoverable || config.searchDbPath === ":memory:") throw err
      await removeSidecarDatabase(config.searchDbPath)
      return SearchSidecar.openMigrated(config, false)
    }
  }

  close() {
    this.db.close()
  }

  private tableExists(name: string) {
    const row = this.db
      .prepare("select 1 as found from sqlite_master where type in ('table', 'view') and name = ?")
      .get(name) as { found: number } | undefined
    return Boolean(row)
  }

  private schemaVersionMismatch() {
    if (this.config.searchDbPath === ":memory:") return false
    if (!this.tableExists("index_meta")) return false
    const version = this.getMeta("schema_version")?.value
    return version !== SIDECAR_SCHEMA_VERSION
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
        session_updated integer not null default 0,
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

      create index if not exists document_session_idx on document(session_id);

      create virtual table if not exists document_fts using fts5(
        text,
        content='document',
        content_rowid='rowid'
      );
    `)

    this.setMeta("schema_version", SIDECAR_SCHEMA_VERSION)
    this.setMeta("extractor_version", SEARCH_EXTRACTOR_VERSION)
    this.setMeta("ranking_version", "1")
    this.setMeta("supported_search_modes", "hybrid,fzf")
    this.setMeta("document_prefix", this.config.documentPrefix)
    this.setMeta("query_prefix", this.config.queryPrefix)
    this.setMeta("embedding_base_url", this.config.embedBaseUrl)
    if (this.config.embedModel) this.setMeta("embedding_model", this.config.embedModel)

    // vector_state reflects whether embeddings in document_vec are usable.
    // Never downgrade an "enabled"/"stale" state on open: that is owned by
    // the indexing pipeline, not by connection setup.
    const vectorState = this.getMeta("vector_state")?.value
    if (this.config.disableVector) {
      this.setMeta("vector_state", "disabled")
    } else if (!vectorState || vectorState === "disabled") {
      this.setMeta("vector_state", "unavailable")
    }
  }

  getMeta(key: string) {
    return this.db.prepare("select value from index_meta where key = ?").get(key) as { value: string } | undefined
  }

  setMeta(key: string, value: string) {
    if (this.getMeta(key)?.value === value) return
    this.db.prepare(`
      insert into index_meta(key, value)
      values (?, ?)
      on conflict(key) do update set value = excluded.value
    `).run(key, value)
  }

  async loadVectorExtension() {
    if (this.vectorExtensionLoaded) return true
    if (this.config.disableVector) return false

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
      return false
    }

    return false
  }

  private ensureVectorTable(dimensions: number) {
    this.db.exec(`create virtual table if not exists document_vec using vec0(embedding float[${dimensions}])`)
  }

  private insertEmbeddingRows(documents: VectorEmbeddableDocument[], embeddings: Float32Array[]) {
    const selectRowID = this.db.prepare("select rowid from document where doc_id = ?")
    const insert = this.db.prepare("insert or replace into document_vec(rowid, embedding) values (?, vec_f32(?))")
    for (const [index, document] of documents.entries()) {
      const row = selectRowID.get(document.docID) as { rowid: number } | undefined
      if (!row) continue
      insert.run(row.rowid, embeddings[index])
    }
  }

  /** Replace the entire vector index. Used for initial/full embedding builds. */
  async replaceVectorEmbeddings(documents: VectorEmbeddableDocument[], embeddings: Float32Array[]) {
    if (!documents.length || documents.length !== embeddings.length) return false
    if (!(await this.loadVectorExtension())) return false

    const dimensions = embeddings[0]?.length
    if (!dimensions) return false

    this.ensureVectorTable(dimensions)
    const transaction = this.db.transaction(() => {
      this.db.prepare("delete from document_vec").run()
      this.insertEmbeddingRows(documents, embeddings)
      this.setMeta("embedding_dimensions", String(dimensions))
      this.setMeta("vector_state", "enabled")
    })
    transaction()
    return true
  }

  /**
   * Upsert embeddings for changed documents only. Valid when the rest of the
   * vector index is already populated (state "enabled" or "stale").
   */
  async upsertVectorEmbeddings(documents: VectorEmbeddableDocument[], embeddings: Float32Array[]) {
    if (documents.length !== embeddings.length) return false
    if (!(await this.loadVectorExtension())) return false
    const dimensions = embeddings[0]?.length
    if (documents.length && !dimensions) return false

    if (dimensions) this.ensureVectorTable(dimensions)
    const transaction = this.db.transaction(() => {
      if (dimensions) this.insertEmbeddingRows(documents, embeddings)
      this.setMeta("vector_state", "enabled")
    })
    transaction()
    return true
  }

  async searchVector(queryEmbedding: Float32Array): Promise<RankedCandidate[]> {
    if (!(await this.loadVectorExtension())) return []
    const state = this.getMeta("vector_state")?.value
    if (state !== "enabled") return []
    if (!this.tableExists("document_vec")) return []
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

  allDocumentTexts(): VectorEmbeddableDocument[] {
    return this.db.prepare("select doc_id as docID, text from document order by rowid asc").all() as Array<{
      docID: string
      text: string
    }>
  }

  /**
   * Documents that have no row in document_vec. Requires the vector
   * extension to be loaded when document_vec exists.
   */
  documentsMissingEmbeddings(): VectorEmbeddableDocument[] {
    if (!this.tableExists("document_vec")) return this.allDocumentTexts()
    return this.db
      .prepare(`
        select doc_id as docID, text from document
        where rowid not in (select rowid from document_vec)
        order by rowid asc
      `)
      .all() as Array<{ docID: string; text: string }>
  }

  /**
   * Compare the live session list against the indexed state and report what
   * needs work. Reads the whole indexed_session table to avoid IN-clause
   * variable limits.
   */
  indexDelta(sessions: Array<{ id: string; time?: { updated: number } }>): SessionIndexDelta {
    const indexedRows = this.db
      .prepare("select session_id as sessionID, session_updated as sessionUpdated from indexed_session")
      .all() as Array<{ sessionID: string; sessionUpdated: number }>
    const indexed = new Map(indexedRows.map((row) => [row.sessionID, row.sessionUpdated]))
    const liveIDs = new Set(sessions.map((session) => session.id))
    const removed = indexedRows.map((row) => row.sessionID).filter((id) => !liveIDs.has(id))

    const staleExtractor = this.getMeta("extractor_version")?.value !== SEARCH_EXTRACTOR_VERSION ||
      (this.db
        .prepare("select exists(select 1 from document where extractor_version != ?) as found")
        .get(SEARCH_EXTRACTOR_VERSION) as { found: number }).found === 1
    if (staleExtractor) return { kind: "full", removed }

    const changed = sessions
      .filter((session) => {
        const sessionUpdated = indexed.get(session.id)
        if (sessionUpdated === undefined) return true
        return (session.time?.updated ?? 0) > sessionUpdated
      })
      .map((session) => session.id)

    if (!changed.length && !removed.length) return { kind: "none" }
    return { kind: "incremental", changed, removed }
  }

  /** Back-compat convenience over indexDelta. */
  needsReindex(sessions: Array<{ id: string; time?: { updated: number } }>) {
    return this.indexDelta(sessions).kind !== "none"
  }

  private markVectorStale() {
    if (this.getMeta("vector_state")?.value === "enabled") this.setMeta("vector_state", "stale")
  }

  private upsertIndexedSession(entry: SourceSessionCorpus, sessionDocuments: SearchDocument[], indexedAt: number) {
    this.db
      .prepare(`
        insert into indexed_session(session_id, parent_id, project_id, workspace_id, directory, path, source_hash, session_updated, indexed_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(session_id) do update set
          parent_id = excluded.parent_id,
          project_id = excluded.project_id,
          workspace_id = excluded.workspace_id,
          directory = excluded.directory,
          path = excluded.path,
          source_hash = excluded.source_hash,
          session_updated = excluded.session_updated,
          indexed_at = excluded.indexed_at
      `)
      .run(
        entry.session.id,
        entry.session.parentID ?? null,
        entry.session.projectID,
        entry.session.workspaceID ?? null,
        entry.session.directory,
        entry.session.path ?? null,
        sessionDocuments.map((document) => document.sourceHash).join(":") || entry.session.id,
        entry.session.time?.updated ?? 0,
        indexedAt,
      )
  }

  private insertDocumentRows(documents: SearchDocument[], indexedAt: number) {
    const insertDocument = this.db.prepare(`
      insert into document(
        doc_id, session_id, message_id, part_id, chunk_index, role, part_type,
        synthetic, ignored, title, directory, path, text, metadata_json, source_hash, extractor_version, indexed_at
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.db.prepare("insert into document_fts(rowid, text) values (?, ?)")
    for (const document of documents) {
      const metadata = document.metadata
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
        typeof metadata.title === "string" ? metadata.title : "",
        typeof metadata.directory === "string" ? metadata.directory : "",
        typeof metadata.path === "string" ? metadata.path : "",
        document.text,
        JSON.stringify(document.metadata),
        document.sourceHash,
        SEARCH_EXTRACTOR_VERSION,
        indexedAt,
      )
      // The FTS row must mirror the content table exactly: external-content
      // FTS5 resolves deletes against the content table, and mismatched
      // values corrupt the index.
      insertFts.run(result.lastInsertRowid, document.text)
    }
  }

  private deleteSessionRows(sessionIDs: string[], vectorLoaded: boolean) {
    if (!sessionIDs.length) return
    const selectRowIDs = this.db.prepare("select rowid from document where session_id = ?")
    const deleteFts = this.db.prepare(
      "delete from document_fts where rowid in (select rowid from document where session_id = ?)",
    )
    const deleteDocuments = this.db.prepare("delete from document where session_id = ?")
    const deleteIndexed = this.db.prepare("delete from indexed_session where session_id = ?")
    for (const sessionID of sessionIDs) {
      if (vectorLoaded && this.tableExists("document_vec")) {
        const rowids = (selectRowIDs.all(sessionID) as Array<{ rowid: number }>).map((row) => row.rowid)
        for (const batch of chunk(rowids, SQL_VARIABLE_CHUNK)) {
          this.db
            .prepare(`delete from document_vec where rowid in (${batch.map(() => "?").join(",")})`)
            .run(...batch)
        }
      }
      // Delete FTS rows before the content rows so FTS5 can resolve values.
      deleteFts.run(sessionID)
      deleteDocuments.run(sessionID)
      deleteIndexed.run(sessionID)
    }
  }

  /** Full rebuild of the corpus. Used on first build and extractor upgrades. */
  rebuildCorpus(corpus: SourceSessionCorpus[]) {
    const indexedAt = now()
    const transaction = this.db.transaction(() => {
      // delete-all is the FTS5-supported way to clear an external-content table.
      this.db.prepare("insert into document_fts(document_fts) values ('delete-all')").run()
      this.db.prepare("delete from document").run()
      this.db.prepare("delete from indexed_session").run()
      for (const entry of corpus) {
        const documents = extractSessionDocuments(entry.session, entry.messages)
        this.insertDocumentRows(documents, indexedAt)
        this.upsertIndexedSession(entry, documents, indexedAt)
      }
      this.markVectorStale()
      this.setMeta("extractor_version", SEARCH_EXTRACTOR_VERSION)
      this.setMeta("last_indexed_at", String(indexedAt))
    })
    transaction()
  }

  /**
   * Incrementally replace documents for changed sessions and drop removed
   * sessions. Keeps indexed_session rows even for sessions that produce no
   * documents so they are not perpetually re-fetched.
   */
  upsertSessions(corpus: SourceSessionCorpus[], removedSessionIDs: string[], vectorLoaded: boolean) {
    if (!corpus.length && !removedSessionIDs.length) return
    const indexedAt = now()
    const transaction = this.db.transaction(() => {
      this.deleteSessionRows(
        [...corpus.map((entry) => entry.session.id), ...removedSessionIDs],
        vectorLoaded,
      )
      for (const entry of corpus) {
        const documents = extractSessionDocuments(entry.session, entry.messages)
        this.insertDocumentRows(documents, indexedAt)
        this.upsertIndexedSession(entry, documents, indexedAt)
      }
      if (corpus.length) this.markVectorStale()
      this.setMeta("last_indexed_at", String(indexedAt))
    })
    transaction()
  }

  /** Back-compat full replacement of all documents without session bookkeeping. */
  replaceDocuments(documents: SearchDocument[]) {
    const indexedAt = now()
    const transaction = this.db.transaction(() => {
      this.db.prepare("insert into document_fts(document_fts) values ('delete-all')").run()
      this.db.prepare("delete from document").run()
      this.insertDocumentRows(documents, indexedAt)
      this.markVectorStale()
      this.setMeta("last_indexed_at", String(indexedAt))
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
          snippet(document_fts, 0, '[', ']', ' ... ', 12) as snippet
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

  getSessionDocumentTexts(sessionID: string): Array<{
    messageID: string | null
    partID: string | null
    role: string | null
    partType: string | null
    text: string
    metadataJson: string
  }> {
    return this.db
      .prepare(`
        select
          message_id as messageID,
          part_id as partID,
          role,
          part_type as partType,
          text,
          metadata_json as metadataJson
        from document
        where session_id = ?
        order by rowid asc
      `)
      .all(sessionID) as Array<{
        messageID: string | null
        partID: string | null
        role: string | null
        partType: string | null
        text: string
        metadataJson: string
      }>
  }

  snippetsForSessions(sessionIDs: string[]) {
    if (!sessionIDs.length) return new Map<string, string>()
    const result = new Map<string, string>()
    for (const batch of chunk(sessionIDs, SQL_VARIABLE_CHUNK)) {
      const rows = this.db
        .prepare(`
          select session_id as sessionID, group_concat(text, ' ') as snippet
          from document
          where session_id in (${batch.map(() => "?").join(",")})
          group by session_id
        `)
        .all(...batch) as Array<{ sessionID: string; snippet: string }>
      for (const row of rows) result.set(row.sessionID, row.snippet)
    }
    return result
  }
}

/**
 * Shared sidecar connection cache. Opening the sidecar previously ran the
 * full migration (including meta writes) on every keystroke search and every
 * preview load; reusing one connection removes that cost and the write
 * contention between the search, preview, and indexing paths.
 */
let sharedSidecar: { key: string; sidecar: SearchSidecar } | undefined

function sharedSidecarKey(config: SearchConfig) {
  return [config.searchDbPath, config.disableVector ? "novec" : "vec", config.sqliteVecExtension ?? ""].join("|")
}

export async function openSharedSidecar(config: SearchConfig): Promise<SearchSidecar> {
  const key = sharedSidecarKey(config)
  if (sharedSidecar?.key === key) return sharedSidecar.sidecar
  closeSharedSidecar()
  const sidecar = await SearchSidecar.open(config)
  sharedSidecar = { key, sidecar }
  return sidecar
}

export function closeSharedSidecar() {
  if (!sharedSidecar) return
  try {
    sharedSidecar.sidecar.close()
  } catch {
    /* ignore close failures */
  }
  sharedSidecar = undefined
}

/** Close, delete, and reopen the shared sidecar cache after corruption. */
export async function resetSharedSidecar(config: SearchConfig): Promise<SearchSidecar> {
  closeSharedSidecar()
  await SearchSidecar.resetCache(config)
  return openSharedSidecar(config)
}
