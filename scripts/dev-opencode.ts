import { constants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(import.meta.dir, "..")
const opencodeRoot = path.join(repoRoot, "upstream", "opencode")
const devRoot = path.join(repoRoot, ".opencode-dev")
const devConfigDir = path.join(devRoot, "config")
const devStateDir = path.join(devRoot, "xdg", "state", "opencode")
const tuiConfig = path.join(devRoot, "tui.json")
const pluginEntry = path.join(repoRoot, "src", "tui.tsx")
const realConfigDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
const realStateDir = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "opencode")

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

function stripJsonComments(input: string) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1")
}

async function readThemeFromConfig(file: string) {
  if (!(await exists(file))) return

  const text = await readFile(file, "utf8")
  try {
    const parsed = JSON.parse(stripJsonComments(text)) as { theme?: unknown; tui?: { theme?: unknown } }
    const theme = typeof parsed.theme === "string" ? parsed.theme : parsed.tui && typeof parsed.tui.theme === "string" ? parsed.tui.theme : undefined
    if (theme) return theme
  } catch {
    const match = text.match(/"theme"\s*:\s*"([^"]+)"/)
    if (match) return match[1]
  }
}

async function readGlobalTheme() {
  for (const file of ["tui.json", "tui.jsonc", "opencode.json", "opencode.jsonc"]) {
    const theme = await readThemeFromConfig(path.join(realConfigDir, file))
    if (theme) return theme
  }

  const kvTheme = await readThemeFromKv(path.join(realStateDir, "kv.json"))
  if (kvTheme) return kvTheme
}

async function readThemeFromKv(file: string) {
  if (!(await exists(file))) return

  try {
    const kv = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    return typeof kv.theme === "string" ? kv.theme : undefined
  } catch {
    return
  }
}

async function copyThemeKv() {
  const source = path.join(realStateDir, "kv.json")
  if (!(await exists(source))) return false

  let kv: Record<string, unknown>
  try {
    kv = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>
  } catch {
    return false
  }
  const themeKv = Object.fromEntries(
    ["theme", "theme_mode", "theme_mode_lock"].flatMap((key) => (key in kv ? [[key, kv[key]]] : [])),
  )
  if (Object.keys(themeKv).length === 0) return false

  await mkdir(devStateDir, { recursive: true })
  await writeFile(path.join(devStateDir, "kv.json"), JSON.stringify(themeKv, null, 2) + "\n")
  return true
}

async function copyThemeDirectory(from: string, to: string) {
  if (!(await exists(from))) return false
  await mkdir(path.dirname(to), { recursive: true })
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true, force: true, errorOnExist: false })
  return true
}

async function copyGlobalThemes() {
  let copied = 0
  for (const source of [path.join(realConfigDir, "themes"), path.join(realConfigDir, ".opencode", "themes")]) {
    const target = path.join(devConfigDir, "themes")
    if (await copyThemeDirectory(source, target)) copied++
  }
  return copied
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
await mkdir(devConfigDir, { recursive: true })
await mkdir(devStateDir, { recursive: true })
await mkdir(path.join(devRoot, "home"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "config"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "data"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "state"), { recursive: true })
await mkdir(path.join(devRoot, "xdg", "cache"), { recursive: true })

const theme = await readGlobalTheme()
const copiedThemeDirs = await copyGlobalThemes()
const copiedThemeKv = await copyThemeKv()

await writeFile(
  tuiConfig,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/tui.json",
      ...(theme ? { theme } : {}),
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
  OPENCODE_CONFIG_DIR: devConfigDir,
  OPENCODE_TUI_CONFIG: tuiConfig,
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
}

delete env.OPENCODE_PURE

console.error(`Using disposable OpenCode dev state: ${devRoot}`)
console.error(`Using plugin config: ${tuiConfig}`)
if (theme) console.error(`Copied selected global theme setting: ${theme}`)
if (copiedThemeDirs) console.error(`Copied global theme files into: ${path.join(devConfigDir, "themes")}`)
if (copiedThemeKv) console.error(`Copied global theme KV keys into: ${path.join(devStateDir, "kv.json")}`)
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
