import { constants } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import type { DependencyState, SearchConfig } from "./types"

export type FzfHealth = {
  state: DependencyState
  bin?: string
  version?: string
  message?: string
}

async function isExecutable(file: string) {
  return access(file, constants.X_OK)
    .then(() => true)
    .catch(() => false)
}

async function findOnPath(name: string) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue
    const candidate = path.join(entry, name)
    if (await isExecutable(candidate)) return candidate
  }
}

async function resolveFzfBin(config: SearchConfig) {
  if (config.fzfBin && (await isExecutable(config.fzfBin))) return config.fzfBin
  const fromPath = await findOnPath("fzf")
  if (fromPath) return fromPath
  const devBuild = path.resolve(process.cwd(), "upstream", "fzf", "bin", "fzf")
  if (await isExecutable(devBuild)) return devBuild
}

async function runProcess(input: { cmd: string[]; stdin?: string; env?: Record<string, string | undefined> }) {
  const child = Bun.spawn(input.cmd, {
    stdin: input.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...input.env,
    },
  })
  if (input.stdin !== undefined) {
    child.stdin!.write(input.stdin)
    child.stdin!.end()
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

export async function checkFzf(config: SearchConfig): Promise<FzfHealth> {
  const bin = await resolveFzfBin(config)
  if (!bin) return { state: "unavailable", message: "fzf executable was not found" }

  const version = await runProcess({
    cmd: [bin, "--version"],
    env: { FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "" },
  })
  if (version.exitCode !== 0) {
    return { state: "error", bin, message: version.stderr.trim() || "fzf --version failed" }
  }

  const smoke = await runProcess({
    cmd: [bin, "--filter", "a"],
    stdin: "alpha\nbeta\n",
    env: { FZF_DEFAULT_OPTS: "", FZF_DEFAULT_OPTS_FILE: "" },
  })
  if (smoke.exitCode !== 0 || !smoke.stdout.includes("alpha")) {
    return { state: "error", bin, version: version.stdout.trim(), message: "fzf --filter smoke test failed" }
  }

  return { state: "available", bin, version: version.stdout.trim() }
}

export async function checkEmbeddingServer(config: SearchConfig) {
  const healthUrls = ["/health", "/v1/health"]
  for (const healthUrl of healthUrls) {
    try {
      const response = await fetch(new URL(healthUrl, config.embedBaseUrl))
      if (response.ok) return { state: "available" as const }
    } catch {
      continue
    }
  }
  return { state: "unavailable" as const, message: "embedding health endpoint did not respond" }
}
