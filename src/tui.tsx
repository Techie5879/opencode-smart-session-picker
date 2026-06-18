/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import "opentui-spinner/solid"
import { resolveSearchConfig } from "./search/config"
import { dependencySnapshot, elapsedMs, errorFields, logEvent, nextLogID, nowMs, queryStats } from "./search/logging"
import { PREVIEW_CONTEXT_LINES, loadSessionPreview, type SessionPreview } from "./search/preview"
import { registerSearchIndexInvalidation, searchSessions } from "./search/search"
import { checkSearchEnvironment } from "./search/status"
import type { DependencyState, SearchDependencyStatus, SearchEnvironmentStatus, SearchMode } from "./search/types"

const PLUGIN_ID = "local.smart-session-picker"
const SEARCH_DEBOUNCE_MS = 150
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type SessionStatus = ReturnType<TuiPluginApi["state"]["session"]["status"]>
type SessionOption = TuiDialogSelectOption<string> & {
  gutter?: () => JSX.Element
}

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

function isWorkingStatus(status: SessionStatus) {
  return status?.type === "busy" || status?.type === "retry"
}

function Spinner(props: { api: TuiPluginApi; children?: JSX.Element; color?: RGBA }) {
  const theme = props.api.theme.current
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={props.api.kv.get("animations_enabled", true)} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
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
  const dialogID = nextLogID("dialog")
  const openedAt = nowMs()
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
    const uiSearchID = nextLogID("ui-search")
    setSearchLoading(true)
    try {
      const result = await searchSessions(props.api, nextQuery, { mode: nextMode })
      if (id !== request) {
        logEvent(props.api, "debug", "search.cancelled", {
          component: "dialog",
          dialogID,
          uiSearchID,
          mode: nextMode,
          ...queryStats(nextQuery),
          reason: "superseded",
        })
        return
      }
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
    } catch (err) {
      if (id !== request) return
      setModeError(undefined)
      setSessions([])
      logEvent(props.api, "error", "search.ui_failed", {
        component: "dialog",
        dialogID,
        uiSearchID,
        mode: nextMode,
        ...queryStats(nextQuery),
        ...errorFields(err),
      })
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
      logEvent(props.api, "debug", "environment.checked", {
        component: "dialog",
        dialogID,
        mode: nextMode,
        alpha: result.alpha,
        dependencies: dependencySnapshot(result),
        modeStates: Object.fromEntries(result.modes.map((item) => [item.mode, item.state])),
      })
      const active = result.modes.find((item) => item.mode === nextMode)
      if (active && active.state !== "available") {
        logEvent(props.api, "warn", "dependency.unavailable", {
          component: "dialog",
          dialogID,
          mode: nextMode,
          reason: active.message,
          dependencies: dependencySnapshot(result),
        })
      }
    } catch (err) {
      logEvent(props.api, "error", "environment.failed", {
        component: "dialog",
        dialogID,
        mode: nextMode,
        ...errorFields(err),
      })
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
    // Empty queries are the recency listing - refresh immediately so opening
    // the picker and clearing a search both feel instant.
    if (!q.trim()) {
      void refresh(q, m)
      return
    }
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
    logEvent(props.api, "info", "picker.opened", {
      component: "dialog",
      dialogID,
      mode: mode(),
    })
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    if (previewTimer) clearTimeout(previewTimer)
    request++
    statusRequest++
    previewRequest++
    logEvent(props.api, "info", "picker.closed", {
      component: "dialog",
      dialogID,
      mode: mode(),
      durationMs: elapsedMs(openedAt),
    })
  })

  function toggleMode() {
    const next: SearchMode = mode() === "hybrid" ? "fzf" : "hybrid"
    const env = environment()
    const modeStatus = env?.modes.find((m) => m.mode === next)
    if (modeStatus && modeStatus.state !== "available") {
      props.api.ui.toast({ variant: "warning", message: modeStatus.message ?? `${next} mode is unavailable.` })
      logEvent(props.api, "warn", "mode.change_rejected", {
        component: "dialog",
        dialogID,
        fromMode: mode(),
        toMode: next,
        reason: modeStatus.message,
        modeState: modeStatus.state,
      })
      return
    }
    const previous = mode()
    request++
    setModeError(undefined)
    setMode(next)
    logEvent(props.api, "info", "mode.changed", {
      component: "dialog",
      dialogID,
      fromMode: previous,
      toMode: next,
    })
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
    sessions().map((s): SessionOption => {
      const status = props.api.state.session.status(s.id)
      return {
        title: s.title,
        value: s.id,
        category: dateCategory(s.updated),
        footer: timeFooter(s.updated),
        gutter: isWorkingStatus(status) ? () => <Spinner api={props.api} /> : undefined,
      }
    })

  const currentSessionID = () => {
    const route = props.api.route.current
    return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  }

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
            current={currentSessionID()}
            onMove={(opt: { value: string }) => {
              setSelectedSessionID(opt.value)
              loadPreview(opt.value)
            }}
            onSelect={(opt: { value: string }) => {
              const rank = sessions().findIndex((session) => session.id === opt.value)
              logEvent(props.api, "info", "session.selected", {
                component: "dialog",
                dialogID,
                mode: mode(),
                resultRank: rank >= 0 ? rank + 1 : undefined,
                resultCount: sessions().length,
                ...queryStats(query()),
              })
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
  registerSearchIndexInvalidation(api)

  function openSmartSessionDialog() {
    api.ui.dialog.replace(() => <SmartSessionDialog api={api} />)
  }

  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        namespace: "palette",
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: () => api.state.session.count() > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: openSmartSessionDialog,
      },
    ],
    bindings: api.tuiConfig.keybinds.get("session.list").map((binding) => ({
      ...binding,
      cmd: openSmartSessionDialog,
      desc: binding.desc ?? "Switch session",
    })),
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
