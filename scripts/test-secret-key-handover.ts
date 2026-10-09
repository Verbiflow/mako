import assert from "node:assert/strict"
import { createServer, request } from "node:http"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { dataKeyPath, openHostSecrets, type SecretKeyHandover } from "../electron/host-secrets.ts"
import { handOverSecretKey, SecretKeyLink } from "../electron/secret-key-link.ts"
import { aesSealer, fileSecrets, SecretUnavailable, wrappedKey } from "../electron/secrets.ts"
import type { SecretEncryption } from "../electron/secure-storage.ts"
import { startWebHost } from "../electron/web-host.ts"

/**
 * A host under the Helper in Node mode can't reach the keychain; the desktop
 * app, which can, hands it the data key on the host's private socket. Real
 * sockets and a real host transport, with a stand-in keychain.
 */
const root = await mkdtemp(join(tmpdir(), "mako-key-handover-"))
const userRoot = join(root, "user")
const keyPath = dataKeyPath(userRoot)
const socketAt = (name: string) => join(root, `${name}.sock`)

/** The login keychain as `safeStorage` sees it: reversible, refusing another keychain's, counting unwraps. */
function keychain(id = "one"): SecretEncryption & { open: boolean; decrypts: number; gate?: Promise<void> } {
  const state: SecretEncryption & { open: boolean; decrypts: number; gate?: Promise<void> } = {
    open: true,
    decrypts: 0,
    available: async () => state.open,
    encrypt: async (value: string) => Buffer.from(`${id}:${Buffer.from(value).toString("base64")}`),
    async decrypt(value: Buffer) {
      state.decrypts++
      await state.gate
      const [owner, body] = value.toString().split(":")
      if (!state.open || owner !== id || body === undefined) throw new Error("not this keychain's")
      return Buffer.from(body, "base64").toString()
    },
  }
  return state
}
/** The Helper in Node mode: no `safeStorage` at all. */
const nodeMode: SecretEncryption = {
  available: async () => false,
  encrypt: async () => { throw new Error("no safeStorage") },
  decrypt: async () => { throw new Error("no safeStorage") },
}

const hosts: { close(): void }[] = []
const links: SecretKeyLink[] = []
async function serve(socket: string, handover?: SecretKeyHandover) {
  const host = await startWebHost(socket, async () => JSON.stringify({ ok: true, value: null }), async () => new Response(""), undefined, undefined, undefined, handover)
  hosts.push(host)
  return host
}
function link(socket: string, encryption: SecretEncryption) {
  const made = new SecretKeyLink(socket, keyPath, encryption)
  links.push(made)
  return made
}
function call(socket: string, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method, path }, (response) => {
      let text = ""
      response.setEncoding("utf8").on("data", (chunk: string) => { text += chunk }).on("end", () => resolve({ status: response.statusCode ?? 0, text }))
    })
    req.on("error", reject).end(body)
  })
}
async function until(what: string, done: () => Promise<boolean> | boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`)
    await delay(25)
  }
}
const locked = { name: "SecretLocked", reason: "unavailable" }

try {
  // A fresh store under a Node-mode host: locked until the desktop arrives, then the desktop makes the key.
  const socket = socketAt("host")
  const first = openHostSecrets({ userRoot, encryption: nodeMode, legacy: [] })
  let host = await serve(socket, first.handover)
  assert.deepEqual(JSON.parse((await call(socket, "GET", "/secret-key")).text), { wanted: true })
  assert.equal(await first.secrets.read("saved-key", "cursor"), null, "a fresh store has nothing to wait for")
  await assert.rejects(first.secrets.write("saved-key", "cursor", "v"), SecretUnavailable, "nothing is written that couldn't be read back")
  const desktop = keychain()
  const desk = link(socket, desktop)
  assert.equal(await desk.attached(), "handed")
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600, "the desktop made the key, the user's alone")
  assert.equal(await first.handover.wanted(), false)
  await first.secrets.write("saved-key", "cursor", "handed-value")
  assert.equal((await first.secrets.read("saved-key", "cursor"))?.value, "handed-value")
  const keychainSide = fileSecrets(join(userRoot, "secrets"), aesSealer(wrappedKey(keyPath, keychain())))
  assert.equal((await keychainSide.read("saved-key", "cursor"))?.value, "handed-value", "one store, whichever side sealed it")
  assert.equal(await desk.attached(), "not-wanted", "a host holding the key isn't handed it again")
  assert.equal(desktop.decrypts, 0, "a key just made is never unwrapped")
  await delay(100)
  assert.deepEqual(host.clients(), [], "the desktop watching for a successor isn't a client keeping the host up")

  // Refused at the socket: another key, a malformed offer, another method.
  const refused = await call(socket, "POST", "/secret-key", JSON.stringify({ key: Buffer.alloc(32, 9).toString("base64") }))
  assert.equal(refused.status, 409)
  assert.match(refused.text, /isn't this store's/)
  for (const body of ["{not json", JSON.stringify({ key: 32 }), JSON.stringify({ key: "AA==", more: 1 }), JSON.stringify({ key: "A".repeat(2048) })])
    assert.equal((await call(socket, "POST", "/secret-key", body)).status, 400, body.slice(0, 40))
  assert.equal((await call(socket, "PUT", "/secret-key", "{}")).status, 405)
  assert.equal((await first.secrets.read("saved-key", "cursor"))?.value, "handed-value", "a refused offer leaves the held key")

  // A successor host with no window attaching: the held request hands it over.
  host.close()
  const successor = openHostSecrets({ userRoot, encryption: nodeMode, legacy: [] })
  host = await serve(socket, successor.handover)
  await until("the successor is handed its key", async () => !(await successor.handover.wanted()))
  assert.equal((await successor.secrets.read("saved-key", "cursor"))?.value, "handed-value")
  assert.equal(desktop.decrypts, 1, "one unwrap for the successor")

  // A host that reaches the keychain itself is never offered the key, and the desktop never unwraps it.
  host.close()
  const electron = openHostSecrets({ userRoot, encryption: keychain(), legacy: [] })
  host = await serve(socket, electron.handover)
  assert.equal(await handOverSecretKey(socket, keyPath, desktop), "not-wanted")
  await delay(200)
  assert.equal(desktop.decrypts, 1)
  assert.equal((await electron.secrets.read("saved-key", "cursor"))?.value, "handed-value")

  // A desktop whose keychain is shut, or refuses: one ask per window, never a loop of prompts.
  const lockedSocket = socketAt("locked")
  const waiting = openHostSecrets({ userRoot, encryption: nodeMode, legacy: [] })
  let lockedHost = await serve(lockedSocket, waiting.handover)
  await assert.rejects(waiting.secrets.read("saved-key", "cursor"), locked, "a record waits for the key, it isn't broken")
  const shut = keychain()
  shut.open = false
  assert.equal(await handOverSecretKey(lockedSocket, keyPath, shut), "unavailable")
  const refusing = keychain("another-mac")
  const denied = link(lockedSocket, refusing)
  assert.equal(await denied.attached(), "failed")
  assert.equal(refusing.decrypts, 1)
  lockedHost.close()
  lockedHost = await serve(lockedSocket, waiting.handover)
  await delay(1_200)
  assert.equal(refusing.decrypts, 1, "after a refusal the keychain isn't asked again before the next window")
  assert.equal(await denied.attached(), "failed")
  await delay(300)
  assert.equal(refusing.decrypts, 2, "one ask for that window")
  assert.equal(await waiting.handover.wanted(), true)

  // A keychain prompt nobody answers doesn't hold the window; the handover carries on behind it.
  let answer!: () => void
  const slow = keychain()
  slow.gate = new Promise((resolve) => { answer = resolve })
  const prompt = link(lockedSocket, slow)
  assert.equal(await prompt.attached(50), "pending")
  answer()
  await until("the slow keychain's handover lands", async () => !(await waiting.handover.wanted()))
  assert.equal((await waiting.secrets.read("saved-key", "cursor"))?.value, "handed-value")

  // A host with no handover, or one older than it: nothing to hand over, and no request loop.
  const plainSocket = socketAt("plain")
  await serve(plainSocket)
  assert.equal((await call(plainSocket, "GET", "/secret-key")).status, 404)
  assert.equal(await handOverSecretKey(plainSocket, keyPath, desktop), "not-wanted")
  const olderSocket = socketAt("older")
  let asked = 0
  const older = createServer((req, response) => {
    if (req.url?.startsWith("/secret-key")) asked++
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => older.listen(olderSocket, resolve))
  hosts.push({ close: () => older.close() })
  assert.equal(await link(olderSocket, desktop).attached(), "not-wanted")
  await delay(500)
  assert.ok(asked <= 2, `an older host is asked once, then once more by the watch (${asked})`)

  console.log("Secret key handover: a Node-mode host is locked until the desktop hands its key over the private socket; a fresh store's key made by the desktop; wrong or malformed offers refused; successors handed the key with no window; keychain hosts never offered it; one keychain ask per window after a refusal; an unanswered prompt doesn't hold the window; older hosts left alone")
} finally {
  for (const made of links) made.dispose()
  for (const host of hosts) host.close()
  await rm(root, { recursive: true, force: true })
}
