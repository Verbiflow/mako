import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { build } from "esbuild"
import { invokeRuntime } from "../dist-electron/runtime-connection.js"
import { ensureRuntime } from "../dist-electron/runtime-service.js"

/**
 * The real host, as `ensureRuntime` runs it under Electron's Helper in Node
 * mode, opening a saved key the desktop's keychain guards. A test app of its
 * own name plays the desktop: its `safeStorage` makes its own keychain item and wraps
 * the data key, so no real secret is read, and the item is deleted at the end.
 * The host runs with a throwaway HOME, so it can't reach the keychain itself:
 * the saved model connection reads as unavailable until the test app hands the
 * data key over the host's private socket, and then the host opens it. The key
 * is random and never printed; the host's answer must not carry it either.
 */
if (process.platform !== "darwin") {
  console.log("Node-mode host secrets: macOS only, skipped")
  process.exit(0)
}
const NAME = "mako-secrets-proof-host"
const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-node-host-secrets-"))
const app = join(root, "app")
const dataRoot = join(root, "data")
const home = join(root, "home")
const electron = resolve("node_modules/.bin/electron")
const apiKey = `sk-proof-${randomBytes(24).toString("base64url")}`
const connection = { provider: "openai", model: "proof-model", contextTokens: 128_000 }

function step(name, env) {
  const base = { ...process.env }
  delete base.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [app], {
    env: { ...base, PROOF_ROOT: dataRoot, PROOF_APP: NAME, PROOF_STEP: name, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  })
  let out = ""
  child.stdout.on("data", (chunk) => (out += chunk))
  return new Promise((done) => child.once("exit", done)).then((code) => {
    const line = out.split("\n").find((entry) => entry.startsWith("PROOF "))
    assert.ok(line, `${name} reported (exit ${code})`)
    return JSON.parse(line.slice("PROOF ".length))
  })
}

let host
try {
  await mkdir(app)
  await mkdir(home)
  await writeFile(join(app, "package.json"), JSON.stringify({ name: NAME, version: "0.0.1", type: "module", main: "check.mjs" }))
  await symlink(resolve("node_modules"), join(app, "node_modules"))
  await build({ entryPoints: ["scripts/secrets-keychain-check.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(app, "check.mjs"), logLevel: "warning" })

  const wrote = await step("write", { PROOF_SAVED_KEY: "utility/openai", PROOF_VALUE: JSON.stringify({ ...connection, apiKey }) })
  assert.deepEqual(wrote, { runtime: "electron", available: true, wrote: true }, "the desktop's safeStorage keeps a model connection")

  const started = Date.now()
  host = await ensureRuntime({
    dataRoot,
    executable: resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [resolve(".")],
    cwd: resolve("."),
    env: { ...process.env, HOME: home },
  })
  const client = crypto.randomUUID()
  const settings = () => invokeRuntime(host.socket, client, "mako:utility-model-settings", [])
  console.log(`Node-mode host ready in ${Date.now() - started} ms`)

  const locked = await settings()
  assert.deepEqual(locked.connections, [], "before the handover the host can't open the connection")
  assert.deepEqual(locked.issues.map((issue) => issue.provider), ["openai"], "and says it's unavailable rather than absent")

  const hand = await step("hand", { PROOF_SOCKET: host.socket })
  assert.deepEqual(hand, { runtime: "electron", available: true, handed: "handed" }, "the desktop unwraps the data key through the keychain and hands it over")

  const opened = await settings()
  assert.deepEqual(opened.issues, [], "after the handover nothing is unavailable")
  assert.deepEqual(opened.connections, [connection], "the Node-mode host opens the saved connection with the handed key")
  assert.equal(JSON.stringify(opened).includes(apiKey), false, "the host's answer doesn't carry the key")

  console.log("Node-mode host secrets: the real host under Electron's Helper in Node mode, with no keychain of its own, reads a saved connection as unavailable, then opens it once an Electron process unwraps the data key through the keychain and hands it over the host's socket")
} finally {
  if (host) {
    await invokeRuntime(host.socket, crypto.randomUUID(), "mako:lifecycle-command", [{ kind: "wait", action: "quit" }]).catch(() => undefined)
    const end = Date.now() + 15_000
    while (Date.now() < end && alive(host.info.pid)) await delay(100)
    assert.equal(alive(host.info.pid), false, "the host quits through its lifecycle")
  }
  await run("security", ["delete-generic-password", "-s", `${NAME} Safe Storage`]).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
