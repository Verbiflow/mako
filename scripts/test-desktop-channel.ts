import assert from "node:assert/strict"
import { request } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { DesktopFrame } from "../electron/contracts/desktop-channel.ts"
import { DesktopChannel } from "../electron/desktop-channel.ts"
import { DesktopLink, type DesktopHandlers } from "../electron/desktop-link.ts"
import { startWebHost } from "../electron/web-host.ts"

/**
 * A host under Node asks the desktop app for what only Electron's main
 * process can do, on `POST /desktop`: real sockets and the real host
 * transport, with stand-in answers where Electron would be.
 */
const root = await mkdtemp(join(tmpdir(), "mako-desktop-channel-"))
const socket = join(root, "host.sock")
const hosts: { close(): void }[] = []
const links: DesktopLink[] = []

async function serve(channel: DesktopChannel) {
  const host = await startWebHost(socket, async () => JSON.stringify({ ok: true, value: null }), async () => new Response(""), undefined, undefined, undefined, undefined, (req, res) => channel.attach(req, res))
  hosts.push(host)
  return host
}
function link(handlers: DesktopHandlers, detached?: () => void) {
  const made = new DesktopLink(() => socket, handlers, detached)
  links.push(made)
  made.start()
  return made
}
async function until(check: () => boolean, what: string, ms = 3_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await delay(10)
  }
}
function status(method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on("error", reject)
    req.end()
  })
}

const permissions = { supported: true, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" as const }

try {
  const channel = new DesktopChannel()
  let host = await serve(channel)

  // Nothing attached: every ask says to open the desktop app, and only POST attaches.
  assert.equal(channel.answers("computer-permissions"), false)
  await assert.rejects(channel.ask("computer-permissions", {}), /Open Mako's desktop app/)
  assert.equal(await status("GET", "/desktop"), 405)

  // A desktop attaches and answers what it declared, validated on the way in.
  const frames: Array<(frame: DesktopFrame) => void> = []
  const sent: Array<{ page: string; method: string }> = []
  let detaches = 0
  const pictured = [{ windowId: 7, name: "Notes", thumbnail: { mimeType: "image/jpeg" as const, data: "AAAA" } }]
  let thumbnailsValid = true
  const handlers: DesktopHandlers = {
    "computer-permissions": async () => permissions,
    "computer-permissions-request": async () => { throw new Error("The person said no.") },
    // A desktop that answers out of contract is the host's to refuse.
    "window-thumbnails": async () => thumbnailsValid ? pictured : JSON.parse('[{"windowId":"seven"}]'),
    "window-source": async ({ windowId }) => `window:${windowId}:0`,
    "desk-page-create": async ({ previewId }) => ({ page: `desk-${previewId}`, url: "mako-app://desk/", title: "Mako" }),
    "desk-page-send": async ({ page, method }) => { sent.push({ page, method }); return { echoed: method } },
    "desk-page-destroy": async () => null,
  }
  const first = link(handlers, () => detaches++)
  frames.push((frame) => first.frame(frame))
  await until(() => channel.answers("computer-permissions"), "the desktop to attach")
  assert.ok(channel.attachedPid() === process.pid)
  assert.deepEqual(await channel.ask("computer-permissions", {}), permissions)
  await assert.rejects(channel.ask("computer-permissions-request", {}), /The person said no\./)
  assert.equal(await channel.capturer().source(42), "window:42:0")
  assert.deepEqual(await channel.capturer().windows(), pictured)
  thumbnailsValid = false
  await assert.rejects(channel.capturer().windows(), /answered window-thumbnails with something else/)

  // A desk window the desktop made: commands go out, its own events come back.
  const page = await channel.deskPage("p1")
  assert.equal(page.id, "desk-p1")
  assert.deepEqual(await page.send("Runtime.evaluate", { expression: "1" }), { echoed: "Runtime.evaluate" })
  assert.deepEqual(sent, [{ page: "desk-p1", method: "Runtime.evaluate" }])
  const messages: string[] = []
  let destroyed = 0
  page.onMessage((method) => messages.push(method))
  page.onDestroyed(() => destroyed++)
  frames[0]({ kind: "page", page: "desk-p1", message: { method: "Page.loadEventFired", params: {} } })
  frames[0]({ kind: "page", page: "desk-p1", state: { url: "mako-app://desk/?preview=p1", title: "Thread" } })
  await until(() => messages.length === 1 && page.title() === "Thread", "the page's events")
  assert.equal(page.url(), "mako-app://desk/?preview=p1")
  frames[0]({ kind: "page", page: "desk-p1", destroyed: true })
  await until(() => destroyed === 1, "the page to end")
  await assert.rejects(page.send("Page.reload", {}), /closed/)

  // A second desktop waits while the first answers, and takes over once it leaves; the first one's windows end with it.
  const kept = await channel.deskPage("p2")
  let keptEnded = false
  kept.onDestroyed(() => { keptEnded = true })
  const second = link({ "computer-permissions": async () => ({ ...permissions, accessibility: false }) })
  await delay(1_000)
  assert.equal((await channel.ask("computer-permissions", {})).accessibility, true)
  assert.equal(await status("POST", "/desktop"), 409)
  first.dispose()
  await until(() => keptEnded, "the first desktop's window to end when it leaves")
  await until(() => channel.answers("computer-permissions") && !channel.answers("desk-page-create"), "the second desktop to take over", 8_000)
  assert.equal((await channel.ask("computer-permissions", {})).accessibility, false)
  await assert.rejects(channel.deskPage("p3"), /Open Mako's desktop app/)
  second.dispose()
  await until(() => !channel.answers("computer-permissions"), "the second desktop to leave")

  // The host restarts on the same socket: a desktop still running attaches again.
  const third = link(handlers, () => detaches++)
  await until(() => channel.answers("desk-page-create"), "a desktop to attach")
  const detachesBefore = detaches
  host.close()
  channel.close()
  await until(() => detaches > detachesBefore, "the desktop to notice the host leave")
  const next = new DesktopChannel()
  await delay(300)
  await rm(socket, { force: true })
  host = await serve(next)
  await until(() => next.answers("computer-permissions"), "the desktop to attach to the new host", 8_000)

  // An ask in flight when the desktop goes fails at once rather than at its deadline.
  third.dispose()
  await until(() => !next.answers("window-source"), "the desktop to leave the new host")
  const slow = link({ "window-source": () => new Promise(() => {}) })
  await until(() => next.answers("window-source"), "the slow desktop to attach", 8_000)
  const pending = next.ask("window-source", { windowId: 1 })
  slow.dispose()
  await assert.rejects(pending, /closed/)

  // Browser gateways never forward the route.
  const proxy = await readFile(join(import.meta.dirname, "../electron/web-dev-proxy.mjs"), "utf8")
  assert.match(proxy, /path !== "\/rpc" && path !== "\/events"/)
  assert.doesNotMatch(proxy, /\/desktop/)

  console.log("desktop channel: asks only what the attached desktop declared and validates every answer; failures carry the desktop's words; desk windows relay commands, events, moves and closing; a second desktop waits for the first to leave, then answers, and the first one's windows end with it; a desktop attaches again after a host restart; an ask in flight fails when the desktop leaves; browser gateways never forward /desktop")
} finally {
  for (const made of links) made.dispose()
  for (const host of hosts) host.close()
  await rm(root, { recursive: true, force: true })
}
