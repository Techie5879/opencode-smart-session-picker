/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { resolveSearchConfig } from "./search/config"
import { searchSessions } from "./search/search"
import { checkSearchEnvironment } from "./search/status"
import type { DependencyState, SearchDependencyStatus, SearchEnvironmentStatus, SearchMode } from "./search/types"

const PLUGIN_ID = "local.smart-session-picker"

function dateCategory(updated: number) {
  const date = new Date(updated)
  if (date.toDateString() === new Date().toDateString()) return "Today"
  return date.toDateString()
}

function timeFooter(updated: number) {
  return new Date(updated).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function stateWord(state: DependencyState) {
  if (state === "available") return "ok"
  if (state === "disabled") return "off"
  if (state === "checking") return "..."
  if (state === "error") return "err"
  return "missing"
}

function stateColor(theme: TuiPluginApi["theme"]["current"], state: DependencyState): RGBA {
  if (state === "available") return theme.success
  if (state === "disabled") return theme.textMuted
  if (state === "checking") return theme.info
  if (state === "error") return theme.error
  return theme.warning
}

function shortName(name: SearchDependencyStatus["name"]) {
  if (name === "OpenCode DB") return "opencode-db"
  if (name === "sidecar index") return "sidecar-index"
  if (name === "sqlite-vec") return "sqlite-vec"
  if (name === "llama-server") return "llama-server"
  return name
}

function StatusBar(props: { api: TuiPluginApi; environment: SearchEnvironmentStatus | undefined }) {
  const theme = props.api.theme.current
  return (
    <Show when={props.environment}>
      <box paddingLeft={4} paddingRight={4} paddingBottom={1} flexDirection="row" gap={0}>
        <For each={props.environment!.dependencies}>
          {(dep, i) => (
            <box flexDirection="row" flexShrink={0}>
              <Show when={i() > 0}>
                <text fg={theme.textMuted} wrapMode="none">
                  {" · "}
                </text>
              </Show>
              <text fg={theme.textMuted} wrapMode="none">
                {shortName(dep.name)}{" "}
              </text>
              <text fg={stateColor(theme, dep.state)} wrapMode="none">
                {stateWord(dep.state)}
              </text>
            </box>
          )}
        </For>
        <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
          {"  tab switch mode"}
        </text>
      </box>
    </Show>
  )
}

function SmartSessionDialog(props: { api: TuiPluginApi }) {
  const [mode, setMode] = createSignal<SearchMode>(resolveSearchConfig().mode)
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<{ id: string; title: string; updated: number }[]>([])
  const [environment, setEnvironment] = createSignal<SearchEnvironmentStatus>()
  let request = 0
  let statusRequest = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(nextQuery: string, nextMode: SearchMode) {
    const id = ++request
    try {
      const result = await searchSessions(props.api, nextQuery, { mode: nextMode })
      if (id !== request) return
      setSessions(
        result.sessions.map((s) => ({
          id: s.id,
          title: s.title || `Session ${s.id.slice(0, 8)}`,
          updated: s.time.updated,
        })),
      )
    } catch {
      if (id !== request) return
      setSessions([])
    }
  }

  async function refreshEnvironment(nextMode: SearchMode) {
    const id = ++statusRequest
    try {
      const result = await checkSearchEnvironment({ mode: nextMode })
      if (id !== statusRequest) return
      setEnvironment(result)
    } catch {
      /* swallow – status bar just stays hidden */
    }
  }

  createEffect(() => {
    const q = query()
    const m = mode()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(q, m), 150)
  })

  createEffect(() => {
    void refreshEnvironment(mode())
  })

  onMount(() => {
    props.api.ui.dialog.setSize("xlarge")
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    request++
    statusRequest++
  })

  function toggleMode() {
    const next: SearchMode = mode() === "hybrid" ? "fzf" : "hybrid"
    if (next === "fzf") {
      const env = environment()
      const fzf = env?.modes.find((m) => m.mode === "fzf")
      if (fzf?.state !== "available") {
        props.api.ui.toast({ variant: "warning", message: fzf?.message ?? "fzf is unavailable." })
        return
      }
    }
    setMode(next)
  }

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      toggleMode()
    }
  })

  const options = () =>
    sessions().map((s) => ({
      title: s.title,
      value: s.id,
      category: dateCategory(s.updated),
      footer: timeFooter(s.updated),
    }))

  const { DialogSelect } = props.api.ui

  return (
    <box>
      <DialogSelect
        title={`Sessions · ${mode()}`}
        placeholder={`Search with ${mode()}...`}
        options={options()}
        skipFilter={true}
        onFilter={(q: string) => setQuery(q)}
        onSelect={(opt: { value: string }) => {
          props.api.route.navigate("session", { sessionID: opt.value })
          props.api.ui.dialog.clear()
        }}
      />
      <StatusBar api={props.api} environment={environment()} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const open = () => api.ui.dialog.replace(() => <SmartSessionDialog api={api} />)

  api.command.register(() => [
    {
      title: "Smart session search",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      hidden: true,
      onSelect: open,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
