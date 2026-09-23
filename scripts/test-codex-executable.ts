import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"

const root = await mkdtemp(join(tmpdir(), "mako-codex-executable-"))
try {
  const binary = join(root, "codex")
  const helper = join(root, "node")
  await writeFile(binary, "#!/usr/bin/env node\n")
  await writeFile(helper, "#!/bin/sh\nexit 0\n")
  await Promise.all([chmod(binary, 0o755), chmod(helper, 0o755)])
  // The CLI's own directory contains Node; desktop PATH does not.
  const env = { HOME: process.env.HOME, PATH: root }
  assert.equal(await resolveCodexExecutable(env), binary)
  assert.equal(
    await resolveCodexExecutable({ ...env, CODEX_EXECUTABLE: binary }),
    binary
  )
  if (process.argv.includes("--live")) {
    const selected = await resolveCodexExecutable({
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    })
    assert.ok(selected)
    assert.ok(
      !selected.includes(".app/Contents/"),
      "the installed standalone CLI passes compatibility with desktop PATH"
    )
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(
  "Codex executable: standalone compatibility and explicit selection hold with desktop PATH"
)
