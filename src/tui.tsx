/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

type SessionInfo = {
  id: string
  title: string
  parentID?: string
  time: {
    created: number
    updated: number
  }
}

type LoadState = "idle" | "loading" | "error"

const PLUGIN_ID = "local.smart-session-picker"
const MAX_RESULTS = 50

function timeLabel(value: number) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
}

function categoryLabel(value: number) {
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return "Today"
  return date.toDateString()
}

async function searchSessions(api: TuiPluginApi, query: string): Promise<SessionInfo[]> {
  const response = await api.client.session.list({
    limit: MAX_RESULTS,
    search: query.trim() || undefined,
  })

  if (response.error) {
    throw new Error(typeof response.error === "string" ? response.error : "Failed to list sessions")
  }

  return [...((response.data ?? []) as SessionInfo[])]
    .filter((session) => session.parentID === undefined)
    .sort((a: SessionInfo, b: SessionInfo) => {
      const updatedDay = new Date(b.time.updated).setHours(0, 0, 0, 0) - new Date(a.time.updated).setHours(0, 0, 0, 0)
      if (updatedDay !== 0) return updatedDay
      return b.time.created - a.time.created
    })
}

function optionFor(session: SessionInfo): TuiDialogSelectOption<string> {
  return {
    title: session.title,
    value: session.id,
    category: categoryLabel(session.time.updated),
    footer: timeLabel(session.time.updated),
  }
}

function statusOption(state: LoadState, query: string, error: string | undefined): TuiDialogSelectOption<string>[] {
  if (state === "loading") {
    return [
      {
        title: query ? `Searching for "${query}"` : "Loading sessions",
        value: "__loading__",
        disabled: true,
      },
    ]
  }

  if (state === "error") {
    return [
      {
        title: "Failed to load sessions",
        description: error,
        value: "__error__",
        disabled: true,
      },
    ]
  }

  return []
}

function SmartSessionDialog(props: { api: TuiPluginApi }) {
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<SessionInfo[]>([])
  const [state, setState] = createSignal<LoadState>("idle")
  const [error, setError] = createSignal<string>()
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(nextQuery: string) {
    const id = ++request
    setState("loading")
    setError(undefined)

    try {
      const result = await searchSessions(props.api, nextQuery)
      if (id !== request) return
      setSessions(result)
      setState("idle")
    } catch (err) {
      if (id !== request) return
      setError(err instanceof Error ? err.message : String(err))
      setState("error")
    }
  }

  createEffect(() => {
    const nextQuery = query()
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(nextQuery), 150)
  })

  onMount(() => {
    props.api.ui.dialog.setSize("large")
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    request++
  })

  const options = createMemo(() => {
    const rows = sessions().map(optionFor)
    if (rows.length) return rows

    const status = statusOption(state(), query(), error())
    if (status.length) return status

    return [
      {
        title: query() ? "No matching sessions" : "No sessions found",
        value: "__empty__",
        disabled: true,
      },
    ]
  })

  return (
    <props.api.ui.DialogSelect
      title="Smart Sessions"
      placeholder="Search sessions..."
      options={options()}
      skipFilter={true}
      onFilter={setQuery}
      onSelect={(option) => {
        if (option.disabled) return
        props.api.route.navigate("session", { sessionID: option.value })
        props.api.ui.dialog.clear()
      }}
    />
  )
}

function openSmartSessionPicker(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <SmartSessionDialog api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Smart session search",
      value: "session.list",
      keybind: "session_list",
      category: "Session",
      hidden: true,
      onSelect: () => openSmartSessionPicker(api),
    },
    {
      title: "Smart session search",
      value: "smart-session-picker.open",
      category: "Session",
      onSelect: () => openSmartSessionPicker(api),
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
