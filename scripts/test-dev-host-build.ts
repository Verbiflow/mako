import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { devHostBuild } from "../electron/dev-host-build.ts"
import { RuntimeInfoSchema } from "../electron/contracts/runtime.ts"

const root = mkdtempSync(join(tmpdir(), "mako-host-build-"))
try {
  mkdirSync(join(root, "dist-electron"))
  mkdirSync(join(root, "packages/sessions/dist"), { recursive: true })
  const host = join(root, "dist-electron/main.js")
  const sessions = join(root, "packages/sessions/dist/index.js")
  writeFileSync(host, "same method names, original behavior")
  writeFileSync(sessions, "original parser")
  const original = devHostBuild(root)
  utimesSync(host, new Date(), new Date())
  writeFileSync(join(root, "dist-electron/main.js.map"), "new source map")
  assert.equal(devHostBuild(root), original, "no-op compilation does not force a restart")
  writeFileSync(host, "same method names, corrected behavior")
  const changed = devHostBuild(root)
  assert.notEqual(changed, original, "implementation changes require a new host even when its methods match")
  writeFileSync(sessions, "corrected parser")
  assert.notEqual(devHostBuild(root), changed, "compiled runtime package changes also invalidate the host")
  const info = { protocol: 1, instanceId: "11111111-1111-4111-8111-111111111111", pid: 1, version: "0.0.1", methods: [] }
  assert.equal(RuntimeInfoSchema.parse(info).devBuild, undefined, "legacy hosts remain discoverable for upgrade")
  assert.equal(RuntimeInfoSchema.parse({ ...info, devBuild: original }).devBuild, original, "health parsing retains loaded build identity")
  console.log("PASS: changed executable/package code, unchanged rebuild, and legacy/new health payloads")
} finally { rmSync(root, { recursive: true, force: true }) }
