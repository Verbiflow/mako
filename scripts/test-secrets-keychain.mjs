import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"

/**
 * The host's secrets against the real macOS keychain, through Electron's
 * `safeStorage`, as the host runs today. A test app of its own name makes its
 * own keychain item, so no real secret is read, and the item is deleted at
 * the end. The value is random and never printed.
 *
 * Then the same store in Node mode, as the host will run: there is no
 * `safeStorage` there, so the record reads as locked until an Electron
 * process, as the desktop app does, unwraps the data key through the keychain
 * and hands it over on the host's private socket. And with no desktop, Node
 * mode reads `safeStorage`'s keychain item itself (`chromiumSafeStorage`): it
 * opens the record, takes over an older file, and seals what `safeStorage`
 * opens. Every step runs the same Electron binary that made the item, so
 * macOS asks nothing; Mako Helper reading Mako's item is asked once.
 */
if (process.platform !== "darwin") {
  console.log("Secrets keychain: macOS only, skipped")
  process.exit(0)
}
const NAME = "mako-secrets-proof"
const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-secrets-keychain-"))
const app = join(root, "app")
const value = randomBytes(24).toString("base64url")
const electron = resolve("node_modules/.bin/electron")

const socket = join(root, "host.sock")

function begin(name, env = {}) {
  const base = { ...process.env }
  delete base.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [app], {
    env: { ...base, PROOF_ROOT: root, PROOF_VALUE: value, PROOF_SOCKET: socket, PROOF_APP: NAME, PROOF_STEP: name, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  })
  let out = ""
  const ready = new Promise((done) => {
    child.once("exit", done)
    child.stdout.on("data", (chunk) => {
      out += chunk
      if (out.includes("PROOF_READY\n")) done()
    })
  })
  const report = new Promise((done) => child.once("exit", done)).then((code) => {
    const line = out.split("\n").find((entry) => entry.startsWith("PROOF "))
    assert.ok(line, `${name} reported (exit ${code})`)
    return JSON.parse(line.slice("PROOF ".length))
  })
  return { ready, report }
}
const step = (name, env) => begin(name, env).report

try {
  await mkdir(app)
  await writeFile(join(app, "package.json"), JSON.stringify({ name: NAME, version: "0.0.1", type: "module", main: "check.mjs" }))
  await symlink(resolve("node_modules"), join(app, "node_modules"))
  await build({ entryPoints: ["scripts/secrets-keychain-check.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(app, "check.mjs") })

  const wrote = await step("write")
  assert.deepEqual(wrote, { runtime: "electron", available: true, wrote: true }, "Electron's safeStorage keeps a secret")
  const record = await readFile(join(root, "secrets", "saved-key", "proof.json"), "utf8")
  assert.equal(record.includes(value), false, "the record holds no value in the clear")
  const key = Buffer.from(JSON.parse(await readFile(join(root, "secrets", "data-key"), "utf8")).wrapped, "base64")
  assert.equal(key.subarray(0, 3).toString(), "v10", "the data key is wrapped by the keychain (Chromium's v10 format)")

  const read = await step("read")
  assert.deepEqual(read, { runtime: "electron", available: true, matched: true }, "another process opens it through the keychain")

  const helper = await step("read", { ELECTRON_RUN_AS_NODE: "1" })
  assert.deepEqual(helper, { runtime: "node", available: false, failed: "locked:unavailable" }, "Node mode has no safeStorage: the record reads as locked, never as absent")

  const host = begin("serve", { ELECTRON_RUN_AS_NODE: "1" })
  await host.ready
  const hand = await step("hand")
  assert.deepEqual(hand, { runtime: "electron", available: true, handed: "handed" }, "the desktop unwraps the key through the keychain and hands it over")
  assert.deepEqual(await host.report, { runtime: "node", available: false, wanted: true, matched: true }, "the Node-mode host opens the record with the handed key")

  // With no desktop, a Node-mode host reads safeStorage's keychain item itself.
  const alone = await step("keychain-read", { ELECTRON_RUN_AS_NODE: "1" })
  assert.deepEqual(alone, { runtime: "node", available: false, keychain: true, matched: true }, "Node mode unwraps Electron's data key through the keychain item, in its own process")

  await mkdir(join(root, "legacy"))
  assert.deepEqual(await step("legacy-write"), { runtime: "electron", available: true, wrote: true })
  const adopted = await step("legacy-read", { ELECTRON_RUN_AS_NODE: "1" })
  assert.deepEqual(adopted, { runtime: "node", available: false, keychain: true, matched: true, adopted: true }, "Node mode takes over an older file safeStorage sealed")

  assert.deepEqual(await step("node-seal", { ELECTRON_RUN_AS_NODE: "1" }), { runtime: "node", available: false, keychain: true, wrote: true })
  assert.deepEqual(await step("electron-open"), { runtime: "electron", available: true, opened: true }, "safeStorage opens what Node mode sealed")

  console.log("Secrets keychain: Electron's safeStorage wraps the data key, a second process opens the record, Node mode without a keychain reads it as locked, a Node-mode host opens it once an Electron process hands it the key over its socket, and Node mode reading the keychain item itself opens the record, takes over an older safeStorage file and seals what safeStorage opens")
} finally {
  await run("security", ["delete-generic-password", "-s", `${NAME} Safe Storage`]).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
