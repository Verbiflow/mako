// Acceptance client only: borrows the supplied task; never starts/stops a session.
import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extractFile } from "@electron/asar"
import { readControlSession, invokeControlSession } from "@mako/control-runtime/session"
import { localRuntime } from "../install-local-mac.mjs"
import { readLocalAppMetadata } from "../local-app-metadata.mjs"
import { resolveLocalIdentity, verifyLocalSignature } from "../mac-local-signing.mjs"
import { invokeRuntime } from "../../dist-electron/runtime-connection.js"

export async function installedControlAudit(sessionFile) {
  const app = "/Applications/Mako.app"
  const runtime = await localRuntime()
  assert.ok(runtime.host, "Installed host must already be running")
  const client = randomUUID()
  const metadata = readLocalAppMetadata(app)
  const installation = await invokeRuntime(runtime.socket, client, "mako:installation-state", [])
  assert.equal(installation.build?.id, metadata.makoBuild.id, "Running host must match installed bundle")
  const signature = await verifyLocalSignature(app, await resolveLocalIdentity())
  const descriptor = await readControlSession(sessionFile)
  const call = command => invokeControlSession(descriptor, { method: "call", command }, AbortSignal.timeout(30000))
  const modules = {}
  for (const name of ["control-media", "control-recording", "recording-render", "recording-encoder", "recording-encoder-worker", "recording-encoder-process", "recording-video-input"]) {
    const path = `node_modules/@mako/control-runtime/dist/${name}.js`
    const bytes = extractFile(`${app}/Contents/Resources/app.asar`, path)
    assert.ok(bytes.equals(await readFile(`packages/control-runtime/dist/${name}.js`)), `Installed ${name} must match reviewed build`)
    modules[name] = createHash("sha256").update(bytes).digest("hex")
  }
  const mediaRoot = `${app}/Contents/Resources/control-media/darwin-arm64`
  const media = JSON.parse(await readFile(`${mediaRoot}/provenance.json`, "utf8"))
  // Signing changes Mach-O bytes. Provenance records pre-sign hashes; the strict
  // bundle signature above verifies deployed bytes. Record both, never equate them.
  const signedMediaHashes = {}
  for (const name of Object.keys(media.binaries))
    signedMediaHashes[name] = createHash("sha256").update(await readFile(`${mediaRoot}/${name}`)).digest("hex")
  let ownedTarget
  return {
    socket: runtime.socket, client,
    hostPid: runtime.host.pid, sessionPid: descriptor.pid,
    identity: { build: metadata.makoBuild, signature, hostPid: runtime.host.pid,
      sessionPid: descriptor.pid, sessionBuild: descriptor.build, modules, media, signedMediaHashes },
    async execute(source) {
      const blocks = await invokeControlSession(descriptor, { method: "exec", source }, AbortSignal.timeout(60000))
      assert.ok(Array.isArray(blocks), "Program result must contain output blocks")
      const last = blocks.filter(block => block.type === "text").at(-1)
      assert.ok(last, "Program must explicitly return its verification result")
      return JSON.parse(last.text)
    },
    async run(command) {
      const { action, ...args } = command
      let result
      if (action === "connect") result = await call(command)
      else if (action === "recording") result = await call({ ...command, target: { kind: "page", ...command.target } })
      else result = await call({ action: "page", name: action, args })
      if (action === "open") ownedTarget = { browser: result.browser, tab: result.tab, generation: result.generation, lease: result.lease }
      if (action === "close") ownedTarget = undefined
      return result
    },
    async close() {
      if (ownedTarget) await call({ action: "page", name: "close", args: { target: ownedTarget } })
      ownedTarget = undefined
    },
  }
}
