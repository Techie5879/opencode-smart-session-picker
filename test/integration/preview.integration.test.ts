import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { linesFromSyncedState, sanitizePreviewTextLines } from "../../src/search/preview"

describe("session preview", () => {
  test("collapses multiline image data URLs", () => {
    const lines = sanitizePreviewTextLines(
      [
        "clipboard",
        "data:image/png;base64,",
        "iVBORw0KGgoAAAANSUhEUgAACNwAAAgECAYAAABsG/",
        "t7hAAAKs2lDQ1BJQ0MgUHJvZmlsZQAASImVlwdUU9kWhs+",
        "normal text",
      ].join("\n"),
    )

    expect(lines).toEqual(["clipboard", "[image]", "normal text"])
  })

  test("collapses inline image data URLs without hiding following text", () => {
    const lines = sanitizePreviewTextLines(
      "attached data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD= done",
    )

    expect(lines).toEqual(["attached [image] done"])
  })

  test("uses synced TUI state messages and parts for preview lines", async () => {
    const messages: Message[] = [
      {
        id: "msg_late",
        sessionID: "ses_one",
        role: "assistant",
        time: { created: 2 },
        parentID: "msg_early",
        modelID: "test",
        providerID: "local",
        mode: "build",
        agent: "build",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        id: "msg_early",
        sessionID: "ses_one",
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "local", modelID: "test" },
      },
    ]
    const parts: Record<string, Part[]> = {
      msg_early: [
        {
          id: "part_user",
          sessionID: "ses_one",
          messageID: "msg_early",
          type: "text",
          text: "find semantic sessions",
        },
      ],
      msg_late: [
        {
          id: "part_ignored",
          sessionID: "ses_one",
          messageID: "msg_late",
          type: "text",
          text: "hidden",
          ignored: true,
        },
        {
          id: "part_assistant",
          sessionID: "ses_one",
          messageID: "msg_late",
          type: "text",
          text: "ranked results",
        },
      ],
    }
    const api = {
      state: {
        ready: true,
        session: {
          messages: (sessionID: string) => (sessionID === "ses_one" ? messages : []),
        },
        part: (messageID: string) => parts[messageID] ?? [],
      },
    } as unknown as TuiPluginApi

    const lines = await linesFromSyncedState(api, "ses_one")

    expect(lines?.map((line) => line.text)).toEqual([
      "[user]",
      "find semantic sessions",
      "",
      "[assistant]",
      "ranked results",
      "",
    ])
  })
})
