import { describe, expect, test } from "bun:test"
import { sanitizePreviewTextLines } from "../../src/search/preview"

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
})
