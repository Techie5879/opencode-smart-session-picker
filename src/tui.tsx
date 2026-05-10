/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { resolveSearchConfig } from "./search/config"
import { PREVIEW_CONTEXT_LINES, loadSessionPreview, type SessionPreview } from "./search/preview"
import { searchSessions } from "./search/search"
import { checkSearchEnvironment } from "./search/status"
import type { DependencyState, SearchDependencyStatus, SearchEnvironmentStatus, SearchMode } from "./search/types"

const PLUGIN_ID = "local.smart-session-picker"
const SEARCH_DEBOUNCE_MS = 300

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

function searchTerms(query: string) {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length)
}

function highlightSegments(text: string, query: string) {
  const terms = searchTerms(query)
  if (!terms.length) return [{ text, highlight: false }]

  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    let from = 0
    while (from < lower.length) {
      const start = lower.indexOf(term, from)
      if (start < 0) break
      ranges.push({ start, end: start + term.length })
      from = start + Math.max(1, term.length)
    }
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  if (!merged.length) return [{ text, highlight: false }]

  const segments: Array<{ text: string; highlight: boolean }> = []
  let index = 0
  for (const range of merged) {
    if (range.start > index) segments.push({ text: text.slice(index, range.start), highlight: false })
    segments.push({ text: text.slice(range.start, range.end), highlight: true })
    index = range.end
  }
  if (index < text.length) segments.push({ text: text.slice(index), highlight: false })
  return segments
}

function StatusBar(props: {
  api: TuiPluginApi
  environment: SearchEnvironmentStatus | undefined
  modeError: string | undefined
}) {
  const theme = props.api.theme.current

  return (
    <box flexDirection="column" paddingLeft={4} paddingRight={4} paddingBottom={1}>
      <Show
        when={props.environment}
        fallback={
          <>
            <box height={1} flexShrink={0} />
            <box>
              <text fg={theme.textMuted} wrapMode="none">
                {"tab to switch mode"}
              </text>
            </box>
          </>
        }
      >
        <For each={props.environment!.modes}>
          {(modeStatus) => {
            const deps = () => props.environment!.modeDependencies[modeStatus.mode as SearchMode]
            return (
              <box>
                <text wrapMode="none">
                  <span style={{ fg: modeLabelColor(theme, deps()) }}>{modeStatus.mode}</span>
                  <span style={{ fg: theme.textMuted }}>{"  "}</span>
                  <For each={deps()}>
                    {(dep, i) => (
                      <>
                        <Show when={i() > 0}>
                          <span style={{ fg: theme.textMuted }}>{" · "}</span>
                        </Show>
                        <span style={{ fg: theme.textMuted }}>{shortName(dep.name)}</span>
                        <span style={{ fg: stateColor(theme, dep.state) }}>{` ${stateWord(dep.state)}`}</span>
                      </>
                    )}
                  </For>
                </text>
              </box>
            )
          }}
        </For>
        <box height={1} flexShrink={0}>
          <text fg={theme.warning} wrapMode="none">
            {props.modeError ?? " "}
          </text>
        </box>
        <box>
          <text fg={theme.textMuted} wrapMode="none">
            {"tab to switch mode"}
          </text>
        </box>
      </Show>
    </box>
  )
}

function PreviewPane(props: {
  api: TuiPluginApi
  preview: SessionPreview | undefined
  loading: boolean
  query: string
  height: number
}) {
  const theme = props.api.theme.current
  const scrollHeight = () => Math.max(6, props.height - 3)
  let scrollbox: ScrollBoxRenderable | undefined

  createEffect(() => {
    if (!props.preview) return
    scrollbox?.scrollTo({ x: 0, y: 0 })
  })

  return (
    <box
      height={props.height}
      flexShrink={0}
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
        <scrollbox
          ref={(el) => {
            scrollbox = el
          }}
          height={scrollHeight()}
          scrollbarOptions={{ visible: false }}
        >
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
                  <For each={line.isMatch ? highlightSegments(line.text || " ", props.query) : [{ text: line.text || " ", highlight: false }]}>
                    {(segment) => (
                      <span
                        style={
                          segment.highlight
                            ? { fg: theme.selectedListItemText, bg: theme.accent }
                            : { fg: line.isMatch ? theme.text : line.kind === "role" ? theme.primary : theme.text }
                        }
                      >
                        {segment.text}
                      </span>
                    )}
                  </For>
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
  const dims = useTerminalDimensions()
  const [mode, setMode] = createSignal<SearchMode>(resolveSearchConfig().mode)
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<{ id: string; title: string; updated: number }[]>([])
  const [environment, setEnvironment] = createSignal<SearchEnvironmentStatus>()
  const [modeError, setModeError] = createSignal<string>()
  const [preview, setPreview] = createSignal<SessionPreview>()
  const [previewLoading, setPreviewLoading] = createSignal(false)
  const [searchLoading, setSearchLoading] = createSignal(false)
  const [selectedSessionID, setSelectedSessionID] = createSignal<string>()
  let request = 0
  let statusRequest = 0
  let previewRequest = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  const pickerHeight = () => Math.max(12, Math.floor(dims().height / 2) - 2)

  async function refresh(nextQuery: string, nextMode: SearchMode) {
    const id = ++request
    setSearchLoading(true)
    try {
      const result = await searchSessions(props.api, nextQuery, { mode: nextMode })
      if (id !== request) return
      setModeError(result.modeUnavailable)
      const nextSessions = result.sessions.map((s) => ({
        id: s.id,
        title: s.title || `Session ${s.id.slice(0, 8)}`,
        updated: s.time.updated,
      }))
      setSessions(nextSessions)

      const current = selectedSessionID()
      const nextSelection = nextSessions.some((s) => s.id === current) ? current : nextSessions[0]?.id
      setSelectedSessionID(nextSelection)
      if (nextSelection) loadPreview(nextSelection, nextQuery)
      else {
        if (previewTimer) clearTimeout(previewTimer)
        previewRequest++
        setPreview(undefined)
        setPreviewLoading(false)
      }
    } catch {
      if (id !== request) return
      setModeError(undefined)
      setSessions([])
    } finally {
      if (id === request) setSearchLoading(false)
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

  function loadPreview(sessionID: string, previewQuery = query()) {
    if (previewTimer) clearTimeout(previewTimer)
    const id = ++previewRequest
    setPreview(undefined)
    setPreviewLoading(true)
    previewTimer = setTimeout(async () => {
      previewTimer = undefined
      try {
        const result = await loadSessionPreview(props.api, sessionID, previewQuery, PREVIEW_CONTEXT_LINES)
        if (id !== previewRequest || query() !== previewQuery || selectedSessionID() !== sessionID) return
        setPreview(result)
      } catch {
        if (id !== previewRequest || query() !== previewQuery || selectedSessionID() !== sessionID) return
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
    timer = setTimeout(() => void refresh(q, m), SEARCH_DEBOUNCE_MS)
  })

  createEffect(() => {
    void refreshEnvironment(mode())
  })

  createEffect(() => {
    const q = query()
    const current = untrack(selectedSessionID)
    if (previewTimer) clearTimeout(previewTimer)
    previewRequest++
    setPreview(undefined)
    if (current) loadPreview(current, q)
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
    request++
    setModeError(undefined)
    setMode(next)
  }

  function updateQuery(next: string) {
    if (next === query()) return
    request++
    setSearchLoading(true)
    setQuery(next)
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
      <box flexDirection="row" height={pickerHeight()} flexShrink={0}>
        <box flexGrow={3} flexBasis={0} height={pickerHeight()} flexShrink={0}>
          <DialogSelect
            title={`Sessions · ${mode()}`}
            placeholder={`Search with ${mode()}...`}
            options={options()}
            skipFilter={true}
            onFilter={updateQuery}
            onMove={(opt: { value: string }) => {
              setSelectedSessionID(opt.value)
              loadPreview(opt.value)
            }}
            onSelect={(opt: { value: string }) => {
              props.api.route.navigate("session", { sessionID: opt.value })
              props.api.ui.dialog.clear()
            }}
          />
        </box>
        <PreviewPane
          api={props.api}
          preview={preview()}
          loading={previewLoading()}
          query={query()}
          height={pickerHeight()}
        />
      </box>
      <StatusBar
        api={props.api}
        environment={environment()}
        modeError={modeError() ?? (searchLoading() && !previewLoading() ? "Searching..." : undefined)}
      />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    id: undefined,
    slots: {
      app: () => {
        useKeyboard((evt) => {
          if (!evt.defaultPrevented) return
          if (!api.keybind.match("session_list", evt)) return
          api.ui.dialog.replace(() => <SmartSessionDialog api={api} />)
        })
        return <box />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
