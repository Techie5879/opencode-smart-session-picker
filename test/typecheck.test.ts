import { expect, test } from "bun:test"

test("tsc --noEmit", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "typecheck"],
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)

  expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0)
})
