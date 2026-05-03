import { resolveSearchConfig } from "./config"
import { checkEmbeddingServer, checkFzf } from "./dependencies"
import { SearchSidecar } from "./sidecar"
import type { SearchConfig, SearchDependencyStatus, SearchEnvironmentStatus, SearchMode } from "./types"

async function sourceDbStatus(config: SearchConfig): Promise<SearchDependencyStatus> {
  if (!config.sourceDbPath) {
    return { name: "OpenCode DB", state: "unavailable", message: "No OpenCode source database path is configured." }
  }
  if (config.sourceDbPath === ":memory:") {
    return { name: "OpenCode DB", state: "available", message: "Using the configured in-memory OpenCode database." }
  }
  const file = Bun.file(config.sourceDbPath)
  if (await file.exists()) {
    return { name: "OpenCode DB", state: "available", message: config.sourceDbPath }
  }
  return { name: "OpenCode DB", state: "unavailable", message: `${config.sourceDbPath} does not exist yet.` }
}

async function sidecarStatus(config: SearchConfig): Promise<{
  sidecar: SearchDependencyStatus
  sqliteVec: SearchDependencyStatus
}> {
  let sidecar: SearchSidecar | undefined
  try {
    sidecar = await SearchSidecar.open(config)
    const documents = sidecar.hasDocuments() ? "indexed" : "empty"
    if (config.disableVector) {
      return {
        sidecar: { name: "sidecar index", state: "available", message: `${config.searchDbPath} (${documents})` },
        sqliteVec: { name: "sqlite-vec", state: "disabled", message: "Vector search is disabled by configuration." },
      }
    }

    const loaded = await sidecar.loadVectorExtension()
    return {
      sidecar: { name: "sidecar index", state: "available", message: `${config.searchDbPath} (${documents})` },
      sqliteVec: loaded
        ? { name: "sqlite-vec", state: "available", message: "Vector extension loaded for sidecar queries." }
        : { name: "sqlite-vec", state: "unavailable", message: "sqlite-vec extension/package was not found." },
    }
  } catch (err) {
    return {
      sidecar: {
        name: "sidecar index",
        state: "error",
        message: err instanceof Error ? err.message : "Sidecar index could not be opened.",
      },
      sqliteVec: { name: "sqlite-vec", state: "unavailable", message: "Sidecar index is unavailable." },
    }
  } finally {
    sidecar?.close()
  }
}

async function llamaStatus(config: SearchConfig): Promise<SearchDependencyStatus> {
  if (config.disableVector) {
    return { name: "llama-server", state: "disabled", message: "Vector search is disabled by configuration." }
  }
  const health = await checkEmbeddingServer(config)
  if (health.state === "available") {
    return { name: "llama-server", state: "available", message: `${config.embedBaseUrl} is responding.` }
  }
  return { name: "llama-server", state: health.state, message: health.message ?? `${config.embedBaseUrl} did not respond.` }
}

async function fzfStatus(config: SearchConfig): Promise<SearchDependencyStatus> {
  const health = await checkFzf(config)
  if (health.state === "available") {
    const detail = health.version ? `${health.bin} (${health.version})` : health.bin
    return { name: "fzf", state: "available", message: detail ?? "fzf is available." }
  }
  return { name: "fzf", state: health.state, message: health.message ?? "fzf executable was not found." }
}

export async function checkSearchEnvironment(input: { mode?: SearchMode } = {}): Promise<SearchEnvironmentStatus> {
  const config = { ...resolveSearchConfig(), ...input }
  const [sourceDb, sidecarResult, llama, fzf] = await Promise.all([
    sourceDbStatus(config),
    sidecarStatus(config),
    llamaStatus(config),
    fzfStatus(config),
  ])
  const dependencies = [sourceDb, sidecarResult.sidecar, sidecarResult.sqliteVec, llama, fzf]
  const vectorReady = sidecarResult.sqliteVec.state === "available" && llama.state === "available"
  const hybridAvailable = sidecarResult.sidecar.state === "available"
  const hybridDetail = !hybridAvailable
    ? "sidecar index unavailable"
    : vectorReady
      ? "keyword + vector ready"
      : "keyword ready; vector degraded"

  return {
    mode: config.mode,
    alpha: config.alpha,
    dependencies,
    modeDependencies: {
      hybrid: [sourceDb, sidecarResult.sidecar, sidecarResult.sqliteVec, llama],
      fzf: [fzf],
    },
    modes: [
      {
        mode: "hybrid",
        state: hybridAvailable ? "available" : "unavailable",
        active: config.mode === "hybrid",
        message: `${hybridDetail}. alpha=${config.alpha}`,
      },
      {
        mode: "fzf",
        state: fzf.state,
        active: config.mode === "fzf",
        message: fzf.state === "available" ? "available" : (fzf.message ?? "fzf unavailable"),
      },
    ],
  }
}
