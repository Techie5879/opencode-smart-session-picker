/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { resolveSearchConfig } from "./search/config"
import { PREVIEW_CONTEXT_LINES, loadSessionPreview, type SessionPreview } from "./search/preview"
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


/** Derive a summary color for a mode based on its dependency health. */
function modeLabelColor(
  theme: TuiPluginApi["theme"]["current"],
  deps: SearchDependencyStatus[],
): RGBA {
  const hasError = deps.some((d) => d.state === "error")
  const hasMissing = deps.some((d) => d.state === "unavailable")
  if (hasError) return theme.error
  if (hasMissing) return theme.warning
  return theme.success
}

function StatusBar(props: {
  api: TuiPluginApi
  environment: SearchEnvironmentStatus | undefined
  modeError: string | undefined
}) {
  const theme = props.api.theme.current

  return (
    <Show when={props.environment}>
      <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingBottom={1}>
        <Show when={props.modeError}>
          <box paddingBottom={0}>
            <text fg={theme.warning} wrapMode="none">
              {props.modeError}
            </text>
          </box>
        </Show>
        <For each={props.environment!.modes}>
          {(modeStatus) => {
            const deps = () => props.environment!.modeDependencies[modeStatus.mode as SearchMode]
            return (
              <box flexDirection="row" gap={0}>
                <text fg={modeLabelColor(theme, deps())} wrapMode="none">
                  {modeStatus.mode.padEnd(8)}
                </text>
                <For each={deps()}>
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
              </box>
            )
          }}
        </For>
        <box flexDirection="row" gap={0} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {"tab switch mode"}
          </text>
        </box>
      </box>
    </Show>
  )
}

function PreviewPane(props: {
  api: TuiPluginApi
  preview: SessionPreview | undefined
  loading: boolean
}) {
  const theme = props.api.theme.current
  const dims = useTerminalDimensions()
  const scrollHeight = () => Math.max(6, Math.floor(dims().height / 2) - 4)

  return (
    <box
      flexGrow={2}
      flexBasis={0}
      flexDirection="column"
      border={true}
      borderStyle="rounded"
      borderColor={theme.borderSubtle}
      title="Preview"
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={props.preview}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted} wrapMode="word">
              {props.loading ? "Loading..." : "No preview available"}
            </text>
          </box>
        }
      >
        <scrollbox maxHeight={scrollHeight()} scrollbarOptions={{ visible: false }}>
          <For each={props.preview!.lines}>
            {(line) => (
              <Show
                when={line.kind !== "separator"}
                fallback={<box height={1} />}
              >
                <text
                  fg={
                    line.isMatch
                      ? theme.accent
                      : line.kind === "role"
                        ? theme.primary
                        : theme.text
                  }
                  attributes={line.kind === "role" ? TextAttributes.BOLD : undefined}
                  wrapMode="word"
                >
                  {line.text || " "}
                </text>
              </Show>
            )}
          </For>
          <Show when={props.preview!.matchCount > 0}>
            <box paddingTop={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {`${props.preview!.matchCount} match${props.preview!.matchCount === 1 ? "" : "es"} in ${props.preview!.totalLines} lines`}
              </text>
            </box>
          </Show>
        </scrollbox>
      </Show>
    </box>
  )
}

function SmartSessionDialog(props: { api: TuiPluginApi }) {
  const [mode, setMode] = createSignal<SearchMode>(resolveSearchConfig().mode)
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<{ id: string; title: string; updated: number }[]>([])
  const [environment, setEnvironment] = createSignal<SearchEnvironmentStatus>()
  const [modeError, setModeError] = createSignal<string>()
  const [preview, setPreview] = createSignal<SessionPreview>()
  const [previewLoading, setPreviewLoading] = createSignal(false)
  let request = 0
  let statusRequest = 0
  let previewRequest = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined

  async function refresh(nextQuery: string, nextMode: SearchMode) {
    const id = ++request
    try {
      const result = await searchSessions(props.api, nextQuery, { mode: nextMode })
      if (id !== request) return
      setModeError(result.modeUnavailable)
      setSessions(
        result.sessions.map((s) => ({
          id: s.id,
          title: s.title || `Session ${s.id.slice(0, 8)}`,
          updated: s.time.updated,
        })),
      )
    } catch {
      if (id !== request) return
      setModeError(undefined)
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

  function loadPreview(sessionID: string) {
    if (previewTimer) clearTimeout(previewTimer)
    setPreviewLoading(true)
    previewTimer = setTimeout(async () => {
      const id = ++previewRequest
      try {
        const result = await loadSessionPreview(props.api, sessionID, query(), PREVIEW_CONTEXT_LINES)
        if (id !== previewRequest) return
        setPreview(result)
      } catch {
        if (id !== previewRequest) return
        setPreview(undefined)
      } finally {
        if (id === previewRequest) setPreviewLoading(false)
      }
    }, 50)
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

  createEffect(() => {
    query()
    setPreview(undefined)
  })

  onMount(() => {
    props.api.ui.dialog.setSize("xlarge")
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    if (previewTimer) clearTimeout(previewTimer)
    request++
    statusRequest++
    previewRequest++
  })

  function toggleMode() {
    const next: SearchMode = mode() === "hybrid" ? "fzf" : "hybrid"
    const env = environment()
    const modeStatus = env?.modes.find((m) => m.mode === next)
    if (modeStatus && modeStatus.state !== "available") {
      props.api.ui.toast({ variant: "warning", message: modeStatus.message ?? `${next} mode is unavailable.` })
      return
    }
    setModeError(undefined)
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
    <box flexDirection="column">
      <box flexDirection="row">
        <box flexGrow={3} flexBasis={0}>
          <DialogSelect
            title={`Sessions · ${mode()}`}
            placeholder={`Search with ${mode()}...`}
            options={options()}
            skipFilter={true}
            onFilter={(q: string) => setQuery(q)}
            onMove={(opt: { value: string }) => loadPreview(opt.value)}
            onSelect={(opt: { value: string }) => {
              props.api.route.navigate("session", { sessionID: opt.value })
              props.api.ui.dialog.clear()
            }}
          />
        </box>
        <PreviewPane api={props.api} preview={preview()} loading={previewLoading()} />
      </box>
      <StatusBar api={props.api} environment={environment()} modeError={modeError()} />
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
