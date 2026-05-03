# OpenCode Session Storage Deep Dive

This document focuses on the current SQLite-backed OpenCode session path in
`upstream/opencode`. It intentionally avoids the old JSON session store except
where SQLite migration compatibility affects current behavior.

## Executive Summary

OpenCode sessions are persisted in SQLite, with one `session` row per session,
one `message` row per user/assistant/system message, and one `part` row per
message part. Writes generally enter the system as sync events and are projected
into the concrete SQLite tables. The built-in TUI session picker lists only
session metadata and its search is a title substring search, not transcript
search.

For a semantic session picker, the useful source of truth is the SQLite
`session`, `message`, and `part` tables, or the HTTP/SDK session APIs that read
from those tables. The index should extract searchable text from part JSON,
join it back to session metadata, and treat the built-in `session.list` search
as a fallback metadata query only.

## Database Location

OpenCode chooses its SQLite database in
`packages/opencode/src/storage/db.ts`.

- `OPENCODE_DB` overrides the database path. Absolute paths and `:memory:` are
  accepted directly; relative paths are resolved under OpenCode's data
  directory.
- Otherwise the default is channel-aware. Stable-ish channels use
  `opencode.db`; nonstandard channels use `opencode-<channel>.db`.
- In local isolated plugin testing, this repo's launcher sets XDG paths under
  `.opencode-dev/`, so the database is intentionally separate from the user's
  real OpenCode database.

Relevant files:

- `upstream/opencode/packages/opencode/src/storage/db.ts`
- `upstream/opencode/packages/core/src/global.ts`

## Core Tables

The current session schema is defined in
`upstream/opencode/packages/opencode/src/session/session.sql.ts`.

### `session`

One row per OpenCode session. Important columns:

- `id`: session id, normally prefixed with `ses_`.
- `project_id`: mandatory project association.
- `workspace_id`: optional workspace association.
- `parent_id`: optional parent session id. This is used for child/subagent
  sessions, not for `fork()`.
- `slug`: generated slug for the session.
- `directory`: absolute directory context at session creation time.
- `path`: optional project-relative path used by newer path-aware listing.
- `title`: displayed session title.
- `version`: OpenCode installation version that created the session.
- `agent`, `model`: optional defaults captured on the session.
- `summary_*`, `share_url`, `revert`, `permission`: extra session metadata.
- `time_created`, `time_updated`, `time_compacting`, `time_archived`:
  lifecycle timestamps.

Indexes exist for `project_id`, `workspace_id`, and `parent_id`.

### `message`

One row per message. Important columns:

- `id`: message id, normally prefixed with `msg_`.
- `session_id`: owning session.
- `time_created`, `time_updated`: timestamps.
- `data`: JSON message payload with ids stripped out.

The projector stores message JSON by removing `id` and `sessionID`, then
rehydration adds those ids back when reading.

### `part`

One row per message part. Important columns:

- `id`: part id, normally prefixed with `prt_`.
- `message_id`: owning message.
- `session_id`: owning session.
- `time_created`, `time_updated`: timestamps.
- `data`: JSON part payload with ids stripped out.

Parts are where most transcript text lives. The projector removes `id`,
`messageID`, and `sessionID` before writing JSON, then rehydration adds them
back.

### `session_message`

There is also a newer v2 projection table named `session_message`. For the
current picker/indexing work, the stable and immediately useful corpus remains
`session` + `message` + `part`, because that is what the TUI session routes and
message hydration path use.

## Ids And Sort Direction

IDs are generated in `upstream/opencode/packages/opencode/src/id/id.ts` and
branded in `upstream/opencode/packages/opencode/src/session/schema.ts`.

- Session ids use `SessionID.descending()` and the `ses_` prefix.
- Message ids use `MessageID.ascending()` and the `msg_` prefix.
- Part ids use `PartID.ascending()` and the `prt_` prefix.

The generated id encodes time plus random data. Descending session ids make
newer sessions sort earlier lexicographically. Ascending message/part ids align
with chronological transcript order.

## Session Creation

Session creation goes through `Session.create()` and then `createNext()` in
`upstream/opencode/packages/opencode/src/session/session.ts`.

`Session.create()` derives context from `InstanceState`:

- current directory
- project id
- optional project-relative path
- optional workspace id

`createNext()` builds the `Session.Info` object:

- fresh descending session id
- fresh slug
- current installation version
- project/workspace/path/directory context
- optional parent id
- title
- `time.created` and `time.updated` set to `Date.now()`

It then emits `session.created`, which is projected into the SQLite `session`
table.

## Session Titles

Default titles are created in
`upstream/opencode/packages/opencode/src/session/session.ts`.

- Root sessions start as `New session - ${new Date().toISOString()}`.
- Child sessions start as `Child session - ${new Date().toISOString()}`.

OpenCode can later replace a default root title with an AI-generated title.
That happens in `upstream/opencode/packages/opencode/src/session/prompt.ts`:

- only for root sessions
- only if the title still matches OpenCode's default-title regex
- only when there is exactly one real user message in history
- triggered on the first assistant step
- generated through the `title` agent or a small model
- cleaned to the first non-empty line
- truncated to 100 characters before `setTitle()`

Manual rename uses the normal session update path. The TUI rename dialog calls
`client.session.update({ sessionID, requestBody: { title } })`, backed by
`PATCH /session/:sessionID`.

## Root, Child, And Forked Sessions

`parent_id` means child/subagent session. For example, the task tool creates a
child session with `parentID: ctx.sessionID` and a title derived from the task
description and agent.

`fork()` is different. It creates a new root session, does not set `parentID`,
appends or increments a title suffix such as `(fork #1)`, then copies messages
and parts from the original session while remapping message and part ids. If the
fork request includes a cutoff `messageID`, it copies only the earlier
transcript.

For a root-only picker, prefer a server-side `roots: true` filter instead of
fetching a limited result set and filtering children locally.

## Write Path: Events Projected Into SQLite

Most writes are sync events projected into SQLite by
`upstream/opencode/packages/opencode/src/session/projectors.ts`.

- `session.created` inserts a full `session` row.
- `session.updated` patches selected session columns.
- `session.deleted` deletes the `session` row.
- `message.updated` upserts a `message` row.
- `message.removed` deletes a `message` row.
- `message.part.updated` upserts a `part` row.
- `message.part.removed` deletes a `part` row.

The message and part projectors intentionally strip identity fields before
storing JSON. Current hydrated reads reconstruct full objects by combining the
row ids with `data`.

One important indexing detail: assistant streaming deltas are not the durable
text corpus. `message.part.delta` is a bus event for live UI updates. The
completed part update stores the durable full text in `part.data`.

## Message And Part Payloads

Message and part schemas live in
`upstream/opencode/packages/opencode/src/session/message-v2.ts`.

Messages contain role and model metadata. The key roles for indexing are:

- `user`: user prompt metadata, selected agent/model, optional system/tools.
- `assistant`: model response metadata, parent message id, provider/model,
  cost/tokens, finish/error/summary fields.

Parts are the transcript body. Common searchable part types include:

- `text`: normal prompt or assistant text; has `text`, optional `synthetic`,
  optional `ignored`, and timing metadata.
- `reasoning`: model reasoning text; useful only if the picker deliberately
  wants to index reasoning.
- `tool`: tool call state; completed/error states can include output, title,
  metadata, and attachments.
- `file`: file/resource reference, with mime, filename, URL, and source.
- `patch`: code patch summary/content.
- `step-start` and `step-finish`: assistant step markers.
- `snapshot`: checkpoint/snapshot metadata.

For a first semantic index, the highest-signal content is usually:

- non-ignored `text.text`
- user text before assistant text
- assistant final text
- selected tool titles and completed outputs
- file names and text/plain file expansions when stored as synthetic text

Be careful with `synthetic` and `ignored`:

- `ignored` text should usually be skipped.
- `synthetic` text can include expanded file/resource content. That may be
  useful for search, but it can also dominate embeddings if indexed without
  chunking or weighting.

## Read Path And Transcript Hydration

Message reads are implemented in
`upstream/opencode/packages/opencode/src/session/message-v2.ts`.

- `MessageV2.page()` queries messages by `session_id`, ordered newest-first
  for pagination, then reverses the returned page into chronological order.
- `MessageV2.stream()` pages through a session's messages.
- `MessageV2.parts()` reads parts for message ids.
- `hydrate()` combines message rows with matching part rows and reattaches ids.

The HTTP handler for `GET /session/:id/message` returns hydrated messages. If
no limit is supplied, it streams all messages through `session.messages()`.

## Session Listing And Built-In Picker Search

The built-in TUI picker lives at
`upstream/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`.

Important behavior:

- `Ctrl-X` then `L`, `/sessions`, `/resume`, and `/continue` open the session
  list dialog.
- Search input is debounced by 150ms.
- Search delegates to `client.session.list({ search, limit: 30, ...query })`.
- Built-in search is server-side title substring search.
- The TUI then filters to root sessions locally with `parentID === undefined`.
- Sessions are grouped by `time.updated` day and sorted in the UI.
- Delete uses a two-press confirmation.
- Rename calls the session update endpoint.

The server-side list query is in
`upstream/opencode/packages/opencode/src/session/session.ts`.

For project-scoped listing, filters include:

- project id
- optional workspace id
- optional path/directory context
- optional `roots`
- optional `start`
- optional title `search`
- `limit`, defaulting to 100

The critical line for current search behavior is effectively:

```sql
title LIKE '%' || search || '%'
```

There is no fuzzy search, semantic search, transcript search, message id search,
or tool-output search in the built-in picker path.

## API Surface For A Replacement Picker

The plugin-facing route should use the same primitives as the built-in TUI.

Useful APIs:

- `api.client.session.list(...)`: list sessions from the server.
- `api.client.session.update(...)`: rename/archive/permission update.
- `api.client.session.delete(...)`: delete session.
- `api.route.navigate("session", { sessionID })`: switch the TUI to a selected
  session.
- `api.ui.DialogSelect` / `api.ui.DialogPrompt`: public plugin dialog surfaces.

The plugin state object does not expose the full session list. A picker should
call `api.client.session.list()` or use its own index.

## Practical Implications For Semantic Search

A semantic picker should probably split into two paths:

1. Metadata/list path: use `session.list({ roots: true, ...scope })` for current
   project/session metadata and navigation compatibility.
2. Index path: read from SQLite or from hydrated message APIs to build searchable
   documents from message parts.

For an indexer, a useful document identity is:

```text
session:<session_id>
message:<message_id>
part:<part_id>
```

Useful payload metadata:

- `session_id`
- `message_id`
- `part_id`
- `project_id`
- `workspace_id`
- `parent_id`
- `directory`
- `path`
- `title`
- `role`
- `part_type`
- `time_created`
- `time_updated`

Useful ranking features:

- title substring match
- recency from `session.time_updated`
- project/path/workspace match
- role weighting, usually user text above assistant text
- tool output down-weighting unless query appears in tool title/file name
- root sessions above child sessions unless the user explicitly asks for
  subagent/task sessions

The current OpenCode list API can remain the source for selection, rename, and
delete. The semantic index should own query expansion, embedding search, and
hybrid ranking.

