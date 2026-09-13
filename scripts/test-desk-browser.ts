import assert from "node:assert/strict"
import { z } from "zod"
import { BrowserService } from "../electron/browser-service.js"
import { DeskBrowser, type DeskPage } from "../electron/desk-browser.js"
import { deskUrlPolicy } from "../electron/desk-browser-policy.js"
import { deskFile } from "../electron/desk-scheme.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../electron/contracts/browser-control.js"
import type { JsonObject } from "../electron/codex-app-json.js"

/** An in-memory desk window: answers the protocol subset the service uses. */
function fakePage(previewId: string, log: string[]) {
  const listeners = new Set<(method: string, params: JsonObject) => void>()
  const destroyed = new Set<() => void>()
  let url = `http://127.0.0.1:5173/?preview=${previewId}`
  const page: DeskPage & { emit(method: string, params: JsonObject): void } = {
    id: `desk-${previewId.slice(0, 8)}`,
    url: () => url,
    title: () => "Mako",
    async send(method, params) {
      log.push(method)
      switch (method) {
        case "Accessibility.getFullAXTree":
          return {
            nodes: [
              {
                nodeId: "1",
                ignored: false,
                backendDOMNodeId: 1,
                role: { value: "button" },
                name: { value: "New session" },
              },
            ],
          }
        case "Page.getLayoutMetrics":
          return {
            cssContentSize: { x: 0, y: 0, width: 1600, height: 1000 },
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1600,
              clientHeight: 1000,
            },
          }
        case "Runtime.evaluate":
          return { result: { value: 2 } }
        case "Page.captureScreenshot":
          return {
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
          }
        case "Page.navigate": {
          url = z.string().parse(params.url)
          setTimeout(() => {
            page.emit("Page.lifecycleEvent", {
              frameId: "frame",
              loaderId: "loader",
              name: "load",
            })
          }, 5)
          return { frameId: "frame", loaderId: "loader" }
        }
        default:
          return {}
      }
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onDestroyed(listener) {
      destroyed.add(listener)
      return () => {
        destroyed.delete(listener)
      }
    },
    destroy() {
      for (const listener of destroyed) listener()
    },
    emit(method, params) {
      for (const listener of listeners) listener(method, params)
    },
  }
  return page
}

// URL policy: the exact desk document only, never a look-alike path.
const packaged = deskUrlPolicy({ devServerUrl: null })
assert.equal(packaged("about:blank"), true)
assert.equal(packaged("about:srcdoc"), false)
assert.equal(packaged("mako-app://desk/index.html?preview=x"), true)
assert.equal(packaged("mako-app://desk/index.html"), true)
assert.equal(packaged("mako-app://desk/storage-bridge.html"), false)
assert.equal(packaged("mako-app://desk/assets/index.html"), false)
assert.equal(packaged("mako-app://other/index.html"), false)
assert.equal(packaged("mako-file://asset/index.html"), false)
assert.equal(
  packaged(
    "file:///Applications/Mako.app/Contents/Resources/app.asar/dist/index.html"
  ),
  false
)
assert.equal(packaged("http://127.0.0.1:5173/"), false)
assert.equal(packaged("not a url"), false)
const dev = deskUrlPolicy({ devServerUrl: "http://127.0.0.1:5173" })
assert.equal(dev("http://127.0.0.1:5173/?preview=a"), true)
assert.equal(dev("http://127.0.0.1:5174/"), false)
assert.equal(dev("mako-app://desk/index.html"), false)
assert.equal(dev("file:///anything/dist/index.html"), false)

// The scheme serves the bundle and nothing beside it.
const root = "/Applications/Mako.app/Contents/Resources/app.asar/dist"
assert.equal(deskFile(root, "mako-app://desk/index.html?preview=x"), `${root}/index.html`)
assert.equal(deskFile(root, "mako-app://desk/"), `${root}/index.html`)
assert.equal(deskFile(root, "mako-app://desk/assets/app-1.js"), `${root}/assets/app-1.js`)
assert.equal(deskFile(root, "mako-app://desk/assets/a%20b.js"), `${root}/assets/a b.js`)
// The URL parser folds `..` before the handler sees it; what remains is
// still inside the bundle, and the decoded path is checked again after that.
assert.equal(deskFile(root, "mako-app://desk/../package.json"), `${root}/package.json`)
assert.equal(deskFile(root, "mako-app://desk/assets/%2e%2e/%2e%2e/package.json"), `${root}/package.json`)
assert.equal(deskFile(root, "mako-app://desk/assets/..%2F..%2Fpackage.json"), null)
assert.equal(deskFile(root, "mako-app://desk/..%2Fpackage.json"), null)
assert.equal(deskFile(root, "mako-app://desk/%00"), null)
assert.equal(deskFile(root, "mako-app://desk/%zz"), null)
assert.equal(deskFile(root, "mako-app://other/index.html"), null)
assert.equal(deskFile(root, "mako-file://asset/x"), null)
assert.equal(deskFile(root, "not a url"), null)

const log: string[] = []
const created: string[] = []
const pages = new Map<string, ReturnType<typeof fakePage>>()
const desk = new DeskBrowser({
  maxPages: 2,
  allowsUrl: (url) => url.startsWith("http://127.0.0.1:5173"),
  createPage: async (previewId) => {
    created.push(previewId)
    const page = fakePage(previewId, log)
    pages.set(page.id, page)
    return page
  },
})
const service = new BrowserService(() => [desk.definition])
const run = (
  owner: string,
  input: Parameters<typeof BrowserCommandSchema.parse>[0]
) =>
  service.execute(
    owner,
    BrowserCommandSchema.parse(input),
    new AbortController().signal
  )
try {
  const statuses = z
    .array(z.object({ id: z.string(), name: z.string() }))
    .parse(await run("agent", { action: "status" }))
  assert.deepEqual(
    statuses.map((status) => status.id),
    ["mako"]
  )
  await run("agent", { action: "connect", browser: "mako" })
  assert.equal(service.status()[0].connection.status, "connected")

  // The bridge only accepts the token path it minted.
  const endpoint = await desk.definition.endpoint()
  const { default: WebSocket } = await import("ws")
  const intruder = new WebSocket(endpoint.replace(/[^/]+$/, "wrong-token"))
  await new Promise<void>((resolve) => {
    intruder.once("close", () => resolve())
    intruder.once("error", () => resolve())
  })

  // Opening a tab creates a hidden desk window with its own preview id.
  const opened = BrowserTargetSchema.extend({
    navigation: z.json().optional(),
  }).parse(await run("agent", { action: "open", browser: "mako" }))
  assert.equal(created.length, 1)
  assert.equal(desk.openPages, 1)
  const target = BrowserTargetSchema.parse(opened)
  const observed = z
    .object({
      nodes: z.array(z.object({ ref: z.string(), name: z.string() })),
      info: z.object({ targetInfo: z.object({ url: z.string() }) }),
    })
    .parse(await run("agent", { action: "observe", target }))
  assert.equal(observed.nodes[0].name, "New session")
  assert.match(observed.info.targetInfo.url, /preview=/)
  const shot = z
    .object({ mimeType: z.string(), data: z.string() })
    .parse(await run("agent", { action: "screenshot", target, format: "png" }))
  assert.equal(shot.mimeType, "image/png")
  assert.ok(
    log.includes("Page.enable"),
    "the hidden window is a real page session"
  )

  // Navigation stays inside Mako's own interface.
  await run("agent", {
    action: "navigate",
    target,
    url: "http://127.0.0.1:5173/?preview=other",
  })
  await assert.rejects(
    run("agent", { action: "navigate", target, url: "https://example.test" }),
    /Mako's own interface/
  )
  // open keeps the window it created and reports the refused navigation.
  const refused = BrowserTargetSchema.extend({
    navigation: z.object({ fault: z.object({ message: z.string() }) }),
  }).parse(
    await run("agent", {
      action: "open",
      browser: "mako",
      url: "https://example.test",
    })
  )
  assert.match(refused.navigation.fault.message, /Mako's own interface/)
  await run("agent", {
    action: "close",
    target: {
      browser: refused.browser,
      tab: refused.tab,
      generation: refused.generation,
      lease: refused.lease,
    },
  })

  // A second agent gets its own window; the cap refuses a third.
  const second = BrowserTargetSchema.parse(
    await run("other", { action: "open", browser: "mako" })
  )
  assert.notEqual(second.tab, target.tab)
  await assert.rejects(
    run("third", { action: "open", browser: "mako" }),
    /hidden desk windows open/
  )

  // Closing a tab destroys its window; a destroyed window ends its bindings.
  await run("agent", { action: "close", target })
  assert.equal(desk.openPages, 1)
  await assert.rejects(
    run("agent", { action: "observe", target }),
    /closed or released/
  )
  pages.get(second.tab)?.destroy()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(desk.openPages, 0)

  // An idle window is reaped; a recently driven one survives.
  const idle = BrowserTargetSchema.parse(
    await run("agent", { action: "open", browser: "mako" })
  )
  desk.reapIdle(Date.now() + 5 * 60_000)
  assert.equal(desk.openPages, 1, "five idle minutes keep the window")
  desk.reapIdle(Date.now() + 31 * 60_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(desk.openPages, 0, "thirty idle minutes close it")
  await assert.rejects(
    run("agent", { action: "observe", target: idle }),
    /closed or released/
  )
  await assert.rejects(
    run("other", { action: "observe", target: second }),
    /closed or released/
  )
  console.log(
    "Desk browser: Mako's own interface opens as hidden protocol targets with a private endpoint, page sessions, observation and capture, navigation kept inside the desk, a window cap, idle reaping, and bindings ending with their windows"
  )
} finally {
  service.close()
  desk.close()
}
