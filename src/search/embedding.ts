import type { SearchConfig } from "./types"

type EmbeddingResponse = {
  data?: Array<{
    index?: number
    embedding?: unknown
  }>
  model?: string
}

const HEALTH_TIMEOUT_MS = 1_500
const EMBED_TIMEOUT_MS = 30_000
const EMBED_BATCH_SIZE = 64
const HEALTH_CACHE_TTL_MS = 10_000

const healthCache = new Map<string, { healthy: boolean; checkedAt: number }>()

export class LlamaEmbeddingClient {
  constructor(private readonly config: SearchConfig) {}

  async health() {
    const cached = healthCache.get(this.config.embedBaseUrl)
    if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) return cached.healthy
    const healthy = await this.checkHealth()
    healthCache.set(this.config.embedBaseUrl, { healthy, checkedAt: Date.now() })
    return healthy
  }

  private async checkHealth() {
    for (const endpoint of ["/health", "/v1/health"]) {
      try {
        const response = await fetch(new URL(endpoint, this.config.embedBaseUrl), {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (response.ok) return true
      } catch {
        continue
      }
    }
    return false
  }

  async embedQuery(query: string) {
    return this.embed([this.config.queryPrefix + query]).then((items) => items[0])
  }

  async embedDocuments(documents: string[]) {
    const inputs = documents.map((document) => this.config.documentPrefix + document)
    const out: Float32Array[] = []
    for (let index = 0; index < inputs.length; index += EMBED_BATCH_SIZE) {
      out.push(...(await this.embed(inputs.slice(index, index + EMBED_BATCH_SIZE))))
    }
    return out
  }

  private async embed(inputs: string[]) {
    if (!inputs.length) return []
    const response = await fetch(new URL("/v1/embeddings", this.config.embedBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.embedModel ?? "local-embedding",
        input: inputs,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`)

    const payload = (await response.json()) as EmbeddingResponse
    if (!payload.data || payload.data.length !== inputs.length) {
      throw new Error("Embedding response did not contain one vector per input")
    }

    return [...payload.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) throw new Error("Embedding response contained a non-array embedding")
        const values = item.embedding.map((value: unknown) => Number(value))
        if (values.some((value) => !Number.isFinite(value))) {
          throw new Error("Embedding response contained non-finite values")
        }
        return new Float32Array(values)
      })
  }
}
