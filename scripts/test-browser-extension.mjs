import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { once } from "node:events"
import { WebSocket } from "ws"
import {
  ExtensionMessageSchema,
  NativeMessageDecoder,
} from "../dist-electron/browser-extension-protocol.js"
import { startBrowserNativeHost } from "../dist-electron/browser-native-host.js"
import { extensionBrowsers } from "../dist-electron/browser-extension-registration.js"
import {
  chromiumProfileRoots,
  prepareBrowserExtension,
} from "../dist-electron/browser-extension-setup.js"

const root = await mkdtemp(join(tmpdir(), "mako-extension-test-"))
const input = new PassThrough()
const output = new PassThrough()
const messages = []
const decoder = new NativeMessageDecoder(1024 * 1024)
output.on("data", (chunk) =>
  messages.push(...decoder.push(chunk).map(JSON.parse))
)
function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for bridge message")
}
const bytes = frame({ hello: "split framing" })
const partial = new NativeMessageDecoder(100)
assert.deepEqual(partial.push(bytes.subarray(0, 2)), [])
assert.deepEqual(partial.push(bytes.subarray(2, 7)), [])
assert.deepEqual(partial.push(bytes.subarray(7)), ['{"hello":"split framing"}'])
assert.throws(() => new NativeMessageDecoder(1).push(bytes), /size limit/)
assert.equal(
  ExtensionMessageSchema.safeParse({
    kind: "hello",
    profileId: "cd033952-8c01-4b96-a1b6-8295f595cdec",
    browser: "chrome",
    label: "Old profile",
  }).success,
  false
)
const home = join(root, "home")
const support = join(home, "Library", "Application Support")
const browserState = JSON.stringify({
  browser: { first_run_finished: true },
  profile: { info_cache: { Default: {} } },
})
await mkdir(join(support, "Aside"), { recursive: true })
await mkdir(join(support, "Vendor", "NewBrowser"), { recursive: true })
await mkdir(join(support, "ElectronApp"), { recursive: true })
await writeFile(join(support, "Aside", "Local State"), browserState)
await writeFile(join(support, "Vendor", "NewBrowser", "Local State"), browserState)
await writeFile(
  join(support, "ElectronApp", "Local State"),
  JSON.stringify({ profile: { info_cache: { Default: {} } } })
)
await symlink(join(support, "Aside"), join(support, "LinkedBrowser"))
assert.deepEqual(await chromiumProfileRoots(support), [
  join(support, "Aside"),
  join(support, "Vendor", "NewBrowser"),
])
const appPath = join(root, "app")
await mkdir(join(appPath, "dist-browser-extension"), { recursive: true })
await writeFile(
  join(appPath, "dist-browser-extension", "manifest.json"),
  JSON.stringify({ key: "AA==" })
)
await prepareBrowserExtension(appPath, process.execPath, home)
for (const [profile, product] of [
  [join(support, "Aside"), "Aside"],
  [join(support, "Vendor", "NewBrowser"), "NewBrowser"],
]) {
  const nativeManifest = JSON.parse(
    await readFile(
      join(profile, "NativeMessagingHosts", "dev.mako.browser.json"),
      "utf8"
    )
  )
  assert.equal(nativeManifest.name, "dev.mako.browser")
  assert.match(
    await readFile(nativeManifest.path, "utf8"),
    new RegExp(`MAKO_BROWSER_PRODUCT='${product}'`)
  )
}
await assert.rejects(
  stat(join(support, "ElectronApp", "NativeMessagingHosts")),
  { code: "ENOENT" }
)
const starting = startBrowserNativeHost(root, input, output)
input.write(
  frame({
    kind: "hello",
    profileId: "cd033952-8c01-4b96-a1b6-8295f595cdec",
    family: "chromium",
    product: "Aside",
    label: "Aside profile",
  })
)
const host = await starting
const sockets = []
try {
  const registration = JSON.parse(await readFile(host.registration, "utf8"))
  assert.equal(registration.id, "chromium:cd033952-8c01-4b96-a1b6-8295f595cdec")
  assert.match(host.registration, /chromium-cd033952-/)
  await writeFile(
    join(root, "chrome-cd033952-8c01-4b96-a1b6-8295f595cdec.json"),
    JSON.stringify(registration)
  )
  assert.equal(
    extensionBrowsers(root).length,
    1,
    "old product-specific registration names are ignored"
  )
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(host.registration)).mode & 0o777, 0o600)
  for (const options of [
    { origin: "https://attacker.invalid" },
    { endpoint: registration.endpoint + "wrong" },
  ]) {
    const rejected = new WebSocket(
      options.endpoint ?? registration.endpoint,
      options
    )
    await assert.rejects(once(rejected, "open"), /401/)
  }
  for (let n = 0; n < 2; n++) {
    const socket = new WebSocket(registration.endpoint)
    sockets.push(socket)
    await once(socket, "open")
    socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }))
  }
  await until(() => messages.filter((m) => m.kind === "request").length === 2)
  const requests = messages.filter((m) => m.kind === "request")
  assert.notEqual(requests[0].client, requests[1].client)
  const received = sockets.map(() => [])
  sockets.forEach((socket, index) =>
    socket.on("message", (data) => received[index].push(JSON.parse(data)))
  )
  input.write(
    frame({
      kind: "response",
      client: requests[1].client,
      id: 1,
      result: { proof: "second" },
    })
  )
  await until(() => received[1].length === 1)
  assert.deepEqual(received[0], [])
  assert.equal(received[1][0].result.proof, "second")
  input.write(
    frame({
      kind: "response",
      client: requests[1].client,
      id: 1,
      result: { proof: "replay" },
    })
  )
  const closing = once(sockets[0], "close")
  sockets[0].close()
  await closing
  await until(() =>
    messages.some(
      (m) => m.kind === "disconnect" && m.client === requests[0].client
    )
  )
  assert.equal(received[1].length, 1)
  await host.close()
  await assert.rejects(stat(host.registration), { code: "ENOENT" })
  console.log(
    "Browser extension native bridge: generic Chromium discovery and identity, framing limits, private registration, origin/secret rejection, per-client routing, replay suppression, disconnect and cleanup passed"
  )
} finally {
  sockets.forEach((socket) => socket.terminate())
  await host.close()
  input.destroy()
  output.destroy()
  await rm(root, { recursive: true, force: true })
}
