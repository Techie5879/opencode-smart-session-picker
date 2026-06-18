import type { Session } from "@opencode-ai/sdk/v2"

export type FzfCandidate = {
  session: Session
  snippet?: string
}

export type FzfResult =
  | { status: "ok"; sessionIDs: string[] }
  | { status: "no-match"; sessionIDs: [] }
  | { status: "error"; sessionIDs: []; message: string }

function candidateLine(candidate: FzfCandidate) {
  const parts = [candidate.session.title, candidate.snippet?.replace(/\s+/g, " ")].filter(Boolean)
  return `${candidate.session.id}\t${parts.join(" ")}`
}

export async function runFzfSearch(input: { bin: string; query: string; candidates: FzfCandidate[] }): Promise<FzfResult> {
  const child = Bun.spawn(
    [
      input.bin,
      "--read0",
      "--print0",
      "--filter",
      input.query,
      "--scheme=history",
      "--delimiter",
      "\t",
      "--nth",
      "2..",
      "--accept-nth",
      "1",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FZF_DEFAULT_OPTS: "",
        FZF_DEFAULT_OPTS_FILE: "",
      },
    },
  )

  child.stdin.write(input.candidates.map(candidateLine).join("\0") + "\0")
  child.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode === 1) return { status: "no-match", sessionIDs: [] }
  if (exitCode !== 0) return { status: "error", sessionIDs: [], message: stderr.trim() || `fzf exited with ${exitCode}` }

  const sessionIDs = new TextDecoder()
    .decode(stdout)
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)

  return { status: "ok", sessionIDs }
}
