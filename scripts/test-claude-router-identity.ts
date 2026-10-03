import assert from "node:assert/strict"
import os from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.ts"

const root = await mkdtemp(join(os.tmpdir(), "mako-router-identity-"))
const home = mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
const configured = process.env.CLAUDE_CONFIG_DIR
delete process.env.CLAUDE_CONFIG_DIR
try {
  const defaultDir = join(root, ".claude")
  const router = join(root, ".subrouter", "fixture")
  const routedDir = join(router, "claude", "profile")
  await mkdir(defaultDir, { recursive: true })
  await mkdir(routedDir, { recursive: true })
  await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "default@example.invalid" } }))
  await writeFile(join(router, "claude.json"), JSON.stringify({ profiles: { "stale@example.invalid": { dir: "profile" } } }))
  await writeFile(join(routedDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "actual@example.invalid" } }))
  const discovered = await claudeAccountCapability.listAccounts(null)
  assert.equal(discovered.find((account) => account.source === "subrouter")?.email, "actual@example.invalid")
  assert.equal(discovered.find((account) => account.source === "subrouter")?.name, "stale@example.invalid", "selection keeps its stable router key")
  const selected = await claudeAccountCapability.listAccounts("stale@example.invalid")
  assert.equal(selected.filter((account) => account.active).length, 1)
  assert.equal(selected.find((account) => account.active)?.email, "actual@example.invalid")
  await writeFile(join(routedDir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "default@example.invalid" } }))
  assert.equal((await claudeAccountCapability.listAccounts(null)).length, 1, "stale router aliases must not advertise a second identity")
  assert.equal((await claudeAccountCapability.listAccounts("stale@example.invalid")).find((account) => account.active)?.name, "stale@example.invalid", "the selected route remains visible even when it duplicates a login")
} finally {
  if (configured === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = configured
  home.mock.restore()
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
console.log("PASS: Claude router labels follow native config identity, preserve routing keys and identify the selected route")
