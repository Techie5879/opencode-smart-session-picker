# Session Indexing Notes

These notes turn the session storage model into a concrete indexing plan for a
future semantic session picker.

## Recommended Source Of Truth

Use the current SQLite tables:

- `session`
- `message`
- `part`

Avoid designing around JSON session files. They are migration
compatibility detail, not the target runtime store for this work.

The most direct local extractor can read the OpenCode database with SQLite. A
plugin-only extractor can start with `api.client.session.list()` plus
`GET /session/:id/message`, but a full indexer will eventually want direct DB
access for speed and incremental scans.

## Minimal SQL Shape

A direct DB extractor can start with a join like this:

```sql
select
  s.id as session_id,
  s.project_id,
  s.workspace_id,
  s.parent_id,
  s.directory,
  s.path,
  s.title,
  s.time_created as session_time_created,
  s.time_updated as session_time_updated,
  m.id as message_id,
  m.time_created as message_time_created,
  m.data as message_data,
  p.id as part_id,
  p.time_created as part_time_created,
  p.data as part_data
from session s
join message m on m.session_id = s.id
join part p on p.message_id = m.id and p.session_id = s.id
where s.time_archived is null
order by s.time_updated desc, m.time_created asc, m.id asc, p.time_created asc, p.id asc;
```

The JSON ids are not inside `message.data` or `part.data`, because OpenCode
strips them before writing JSON and reattaches them during hydration.

## Text Extraction Rules

Start conservative:

- `part.data.type = "text"`: index `part.data.text` unless `ignored` is true.
- `part.data.type = "reasoning"`: skip initially unless there is a clear reason
  to search reasoning.
- `part.data.type = "tool"`: index the tool name, completed title, completed
  output, and error text if present. Down-weight verbose outputs.
- `part.data.type = "file"`: index filename, URL, MIME type, and source fields.
- `part.data.type = "patch"`: index patch summary/content, but chunk carefully.
- `part.data.type = "subtask"`: index task description/prompt if present.

Do not treat live `message.part.delta` as durable content. Wait for the final
`message.part.updated` projection, where the full text is stored.

## Suggested Document Model

Use one vector document per meaningful part, with optional session-level summary
documents later.

Part document id:

```text
opencode:<db_fingerprint>:<session_id>:<message_id>:<part_id>
```

Payload:

```json
{
  "sessionID": "ses_...",
  "messageID": "msg_...",
  "partID": "prt_...",
  "projectID": "...",
  "workspaceID": "...",
  "parentID": null,
  "directory": "/repo",
  "path": "packages/app",
  "title": "Investigating subsetgeneratefamilies failure",
  "role": "user",
  "partType": "text",
  "synthetic": false,
  "ignored": false,
  "sessionTimeUpdated": 1777777777777,
  "messageTimeCreated": 1777777770000,
  "partTimeCreated": 1777777770001
}
```

Index text should include enough local context to rank well:

```text
Title: Investigating subsetgeneratefamilies failure
Role: user
Path: packages/app

<part text>
```

For very large synthetic file expansions or tool outputs, chunk by token count
and keep the same `sessionID/messageID/partID` with a `chunkIndex`.

## Incremental Indexing

The easiest first version is periodic reconciliation:

1. Read sessions ordered by `time_updated desc`.
2. For each session changed since the last index run, rebuild all documents for
   that session.
3. Delete indexed documents for sessions no longer present or now archived, if
   the picker should hide archived sessions.

This avoids subtle bugs from part upserts and deletes. It is also good enough
for a local session picker unless the database is very large.

For a more precise version:

- Track max `session.time_updated` scanned.
- Track max `message.time_updated` and `part.time_updated` scanned.
- Rebuild at session granularity whenever any message or part in the session
  changed.
- Periodically reconcile deleted sessions/parts because hard deletes remove the
  rows that would otherwise tell the index what to remove.

The sync `event` table may be useful later, but it should not be the first
indexing contract. The projected tables are simpler, already support the
current API, and are enough to rebuild a deterministic index.

## Hybrid Ranking

A useful first ranking formula:

- exact or fuzzy title match
- semantic vector score from extracted part text
- lexical BM25 score over title + part text
- recency boost from `session.time_updated`
- current project/path/workspace boost
- root-session boost

Return root sessions by default. If a child/subagent session matches strongly,
surface it as a secondary result with its parent relationship visible.

## Picker Integration Shape

The replacement TUI picker should keep OpenCode navigation and mutation on the
official API:

- select: `api.route.navigate("session", { sessionID })`
- rename: `api.client.session.update(...)`
- delete: `api.client.session.delete(...)`
- metadata refresh: `api.client.session.list(...)`

The semantic index should only decide which sessions to show and in what order.
That keeps the plugin small and avoids patching OpenCode core while the search
model is still evolving.
