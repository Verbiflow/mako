import assert from "node:assert/strict"
import { request } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { UpdateState } from "../electron/contracts/automations-usage-updates.ts"
import type { DesktopFrame } from "../electron/contracts/desktop-channel.ts"
import { DesktopChannel } from "../electron/desktop-channel.ts"
import { DesktopLink, type DesktopHandlers, type DesktopLinkOptions } from "../electron/desktop-link.ts"
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
function link(handlers: DesktopHandlers, options: Partial<DesktopLinkOptions> = {}) {
  const made = new DesktopLink({ socket: () => socket, role: "desktop", handlers, ...options })
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
function status(method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on("error", reject)
    req.end()
  })
}

const permissions = { supported: true, persistentAcrossUpdates: true, accessibility: true, screenRecording: "granted" as const }

try {
  const updates: Array<UpdateState | undefined> = []
  const channel = new DesktopChannel({ updated: (state) => updates.push(state) })
  let host = await serve(channel)

  // Nothing attached: every ask says to open the desktop app, only POST attaches, and a desktop says which it is.
  assert.equal(channel.answers("computer-permissions"), false)
  await assert.rejects(channel.ask("computer-permissions", {}), /Open Mako's desktop app/)
  assert.equal(await status("GET", "/desktop"), 405)
  assert.equal(await status("POST", "/desktop"), 400)
  assert.equal(await status("POST", "/desktop", { "x-mako-desktop-role": "someone" }), 400)

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
  const ready: UpdateState = { status: "ready", version: "1.0.0", available: "1.1.0", progress: 100 }
  let installs = 0
  const updating: DesktopHandlers = {
    ...handlers,
    "update-check": async () => ({ status: "checking", version: "1.0.0" }),
    "update-install": async () => { installs++; return null },
  }
  // A desktop tells a host its updater's state as soon as it attaches, since the host knows nothing it told another.
  const first: DesktopLink = link(updating, { detached: () => detaches++, attached: () => first.frame({ kind: "update", state: ready }) })
  frames.push((frame) => first.frame(frame))
  await until(() => channel.answers("computer-permissions"), "the desktop to attach")
  assert.deepEqual(channel.attached(), { pid: process.pid, role: "desktop" })
  await until(() => channel.update()?.status === "ready", "the desktop's update state")
  assert.deepEqual(updates, [ready])
  assert.deepEqual(await channel.ask("update-check", {}), { status: "checking", version: "1.0.0" })
  assert.equal(await channel.ask("update-install", {}), null)
  assert.equal(installs, 1)
  frames[0]({ kind: "update", state: { status: "downloading", version: "1.0.0", progress: 140 } })
  await until(() => !channel.answers("computer-permissions"), "the desktop that sent it to be cut off")
  assert.ok(!updates.some((state) => state?.status === "downloading"), "An update frame out of contract is refused, not taken")
  await until(() => channel.answers("computer-permissions"), "the desktop to attach again", 8_000)
  await until(() => channel.update()?.status === "ready", "the desktop's state to be told again")
  assert.ok(updates.some((state) => state === undefined), "The host hears when the desktop with an updater leaves")
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
  assert.equal(await status("POST", "/desktop", { "x-mako-desktop-role": "desktop" }), 409)
  // The agent views app never takes a person's desktop's place: refused once, it's finished.
  let viewsFinished = false
  link({ "desk-page-create": handlers["desk-page-create"] }, { role: "agent-views", finished: () => { viewsFinished = true } })
  await until(() => viewsFinished, "the refused agent views app to finish")
  assert.equal(channel.attached()?.role, "desktop")
  first.dispose()
  await until(() => keptEnded, "the first desktop's window to end when it leaves")
  await until(() => channel.answers("computer-permissions") && !channel.answers("desk-page-create"), "the second desktop to take over", 8_000)
  assert.equal((await channel.ask("computer-permissions", {})).accessibility, false)
  await assert.rejects(channel.deskPage("p3"), /Open Mako's desktop app/)
  second.dispose()
  await until(() => !channel.answers("computer-permissions"), "the second desktop to leave")

  // The host restarts on the same socket: a desktop still running attaches again.
  const third = link(handlers, { detached: () => detaches++ })
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
  await until(() => !next.answers("window-source"), "the slow desktop to leave")

  // With no desktop, the agent views app the host started makes its windows; a person's desktop that opens replaces it.
  let replacedFinished = false
  link({ "desk-page-create": handlers["desk-page-create"], "desk-page-send": handlers["desk-page-send"], "desk-page-destroy": handlers["desk-page-destroy"] }, { role: "agent-views", finished: () => { replacedFinished = true } })
  await until(() => next.attached()?.role === "agent-views", "the agent views app to attach", 8_000)
  assert.equal(next.answers("computer-permissions"), false, "The agent views app answers nothing about the person's Mac")
  const viewed = await next.deskPage("v1")
  let viewedEnded = false
  viewed.onDestroyed(() => { viewedEnded = true })
  link(handlers)
  await until(() => next.attached()?.role === "desktop", "the desktop to replace the agent views app", 8_000)
  await until(() => viewedEnded && replacedFinished, "the agent views app's windows to end and the app to finish")
  await assert.rejects(viewed.send("Runtime.evaluate", {}), /desktop app opened/)
  assert.ok(next.answers("computer-permissions"))

  // Browser gateways never forward the route.
  const proxy = await readFile(join(import.meta.dirname, "../electron/web-dev-proxy.mjs"), "utf8")
  assert.match(proxy, /path !== "\/rpc" && path !== "\/events"/)
  assert.doesNotMatch(proxy, /\/desktop/)

  console.log("desktop channel: a desktop says which it is; asks only what the attached desktop declared and validates every answer and frame; the desktop's updater state arrives on attaching and on change, and the host hears when it leaves; failures carry the desktop's words; desk windows relay commands, events, moves and closing; a second desktop waits for the first to leave, then answers, and the first one's windows end with it; the agent views app is refused beside a desktop and replaced by one that opens, its windows saying why; a desktop attaches again after a host restart; an ask in flight fails when the desktop leaves; browser gateways never forward /desktop")
} finally {
  for (const made of links) made.dispose()
  for (const host of hosts) host.close()
  await rm(root, { recursive: true, force: true })
}
