import { constants } from "node:fs"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(import.meta.dir, "..")
const opencodeRoot = path.join(repoRoot, "upstream", "opencode")
const devRoot = path.join(repoRoot, ".opencode-dev")
const tuiConfig = path.join(devRoot, "tui.json")
const pluginEntry = path.join(repoRoot, "src", "tui.tsx")

function expandHome(input: string) {
  if (input === "~") return process.env.HOME ?? input
  if (input.startsWith("~/")) return path.join(process.env.HOME ?? "", input.slice(2))
  return input
}

async function exists(file: string) {
  return access(file, constants.F_OK)
    .then(() => true)
    .catch(() => false)
}

const args = process.argv.slice(2)
const firstArgIsWorkspace = args.length === 0 || !args[0]?.startsWith("-")
const workspace = path.resolve(expandHome(firstArgIsWorkspace ? (args[0] ?? repoRoot) : repoRoot))
const passthrough = firstArgIsWorkspace ? [workspace, ...args.slice(1)] : args

if (!(await exists(path.join(opencodeRoot, "node_modules")))) {
  console.error("OpenCode submodule dependencies are missing.")
  console.error("Run: bun install --cwd upstream/opencode")
  process.exit(1)
}

await mkdir(devRoot, { recursive: true })
await mkdir(path.join(devRoot, "config"), { recursive: true })
await mkdir(path.join(devRoot, "home"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "config"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "data"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "state"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "cache"), { recursive: true })

await writeFile(
  tuiConfig,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/tui.json",
      plugin: [pathToFileURL(pluginEntry).href],
    },
    null,
    2,
  ) + "\n",
)

const env: Record<string, string> = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(devRoot, "xdg", "config"),
  XDG_DATA_HOME: path.join(devRoot, "xdg", "data"),
  XDG_STATE_HOME: path.join(devRoot, "xdg", "state"),
  XDG_CACHE_HOME: path.join(devRoot, "xdg", "cache"),
  OPENCODE_TEST_HOME: path.join(devRoot, "home"),
  OPENCODE_CONFIG_DIR: path.join(devRoot, "config"),
  OPENCODE_TUI_CONFIG: tuiConfig,
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
}

delete env.OPENCODE_PURE

console.error(`Using disposable OpenCode dev state: ${devRoot}`)
console.error(`Using plugin config: ${tuiConfig}`)
if (firstArgIsWorkspace) console.error(`Launching upstream OpenCode against: ${workspace}`)
else console.error(`Launching upstream OpenCode with args: ${passthrough.join(" ")}`)

const child = Bun.spawn({
  cmd: ["bun", "run", "dev", ...passthrough],
  cwd: opencodeRoot,
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
