/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const PLUGIN_ID = "local.smart-session-picker"

async function searchSessions(api: TuiPluginApi, query: string): Promise<Session[]> {
  const response = await api.client.session.list({
    roots: true,
    search: query.trim() || undefined,
  })

  if (response.error) {
    throw new Error(typeof response.error === "string" ? response.error : "Failed to list sessions")
  }

  return response.data ?? []
}

function SmartSessionDialog(props: { api: TuiPluginApi }) {
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(nextQuery: string) {
    const id = ++request
    setLoading(true)
    setError(undefined)

    try {
      const result = await searchSessions(props.api, nextQuery)
      if (id !== request) return
      setSessions(result)
      setLoading(false)
    } catch (err) {
      if (id !== request) return
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
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
    const failure = error()
    if (failure) {
      return [
        {
          title: "Failed to load sessions",
          description: failure,
          value: "__error__",
          disabled: true,
        },
      ]
    }

    if (loading()) {
      return [
        {
          title: query() ? `Searching for "${query()}"` : "Loading sessions",
          value: "__loading__",
          disabled: true,
        },
      ]
    }

    const rows = sessions().map((session) => ({
      title: session.title,
      value: session.id,
    }))
    if (rows.length) return rows

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
    {
      title: "Smart session search",
      value: "smart-session-picker.open",
      category: "Session",
      onSelect: open,
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
