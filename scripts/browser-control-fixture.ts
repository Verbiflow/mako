import sharp from "sharp"
import { WebSocketServer, type WebSocket } from "ws"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.js"

const screenshotPixels = (await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")

const commandSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()),
  sessionId: z.string().optional(),
})
interface FixtureTarget {
  title: string
  url: string
  type?: string
  browserContextId?: string
}
type HeldInputType = "mouseMoved" | "mousePressed" | "mouseReleased" | "keyDown" | "rawKeyDown" | "keyUp"
export async function browserFixture() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = z.object({ port: z.number() }).parse(server.address())
  let connections = 0
  let sequence = 0
  const targets = new Map<string, FixtureTarget>()
  const browserContexts = new Set<string>()
  const sessions = new Map<string, string>()
  const calls: z.infer<typeof commandSchema>[] = []
  const sockets = new Set<WebSocket>()
  const axNodes: JsonObject[] = [
    {
      nodeId: "1",
      ignored: false,
      backendDOMNodeId: 1,
      role: { value: "textbox" },
      name: { value: "Proof" },
    },
  ]
  /** Page state the fixture reports to element scripts. */
  interface FixturePage {
    editable: boolean
    focusTakes: boolean
    activeEditable: boolean
    hidden: boolean
    scroll: { x: number; y: number }
    downloadOnClick: boolean
    downloadBehavior: JsonObject | null
    dialogAnswers: JsonObject[]
    nextDialog?: string
    cookies: JsonObject[]
    historyIndex: number
    history: string[]
    selectorPresent: boolean
    inflight: number
  }
  const page: FixturePage = {
    editable: true,
    focusTakes: true,
    activeEditable: true,
    hidden: false,
    scroll: { x: 0, y: 0 },
    /** Whether the next click starts a download. */
    downloadOnClick: false,
    downloadBehavior: null,
    dialogAnswers: [],
    cookies: [],
    historyIndex: 1,
    history: ["https://example.test/one", "https://example.test/two"],
    selectorPresent: false,
    inflight: 0,
  }
  let delayed: (() => void) | undefined
  let holdStop = false
  let delayedStop: (() => void) | undefined
  let recordingFrame: string | undefined
  let holdCookies = false
  let delayedCookies: (() => void) | undefined
  let holdAxRead = false
  let delayedAxRead: (() => void) | undefined
  const heldInputs: {
    type: HeldInputType
    dispatch: (command: z.infer<typeof commandSchema>, complete: (error?: string) => void) => void
  }[] = []
  server.on("connection", (socket) => {
    connections++
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("message", (raw) => {
      const command = commandSchema.parse(JSON.parse(raw.toString()))
      calls.push(command)
      const reply = (result: JsonObject) =>
        socket.send(JSON.stringify({ id: command.id, result }))
      const fail = (message: string) =>
        socket.send(
          JSON.stringify({ id: command.id, error: { code: -32000, message } })
        )
      const tab = command.sessionId
        ? sessions.get(command.sessionId)
        : undefined
      if (command.sessionId && (!tab || !targets.has(tab))) {
        fail("Session with given id not found")
        return
      }
      const emit = (method: string, params: JsonObject) =>
        socket.send(
          JSON.stringify({ method, sessionId: command.sessionId, params })
        )
      if (command.method === "Input.dispatchMouseEvent" || command.method === "Input.dispatchKeyEvent") {
        const index = heldInputs.findIndex((input) => input.type === command.params.type)
        if (index !== -1) {
          const [input] = heldInputs.splice(index, 1)
          input!.dispatch(command, (error) => error === undefined ? reply({}) : fail(error))
          return
        }
      }
      switch (command.method) {
        case "Page.startScreencast":
          reply({})
          if (recordingFrame) emit("Page.screencastFrame", {sessionId: 1, data: recordingFrame, metadata: {deviceWidth: 640, deviceHeight: 480, pageScaleFactor: 1, offsetTop: 0, timestamp: Date.now()/1000}})
          break
        case "Page.stopScreencast":
          if (holdStop) { holdStop = false; delayedStop = () => reply({}) }
          else reply({})
          break
        case "Target.createBrowserContext": {
          const browserContextId = `context-${++sequence}`
          browserContexts.add(browserContextId)
          reply({ browserContextId })
          break
        }
        case "Target.disposeBrowserContext": {
          const browserContextId = z
            .string()
            .parse(command.params.browserContextId)
          browserContexts.delete(browserContextId)
          for (const [targetId, target] of targets)
            if (target.browserContextId === browserContextId)
              targets.delete(targetId)
          for (const [sessionId, targetId] of sessions)
            if (!targets.has(targetId)) sessions.delete(sessionId)
          reply({})
          break
        }
        case "Target.createTarget": {
          const targetId = `tab-${++sequence}`
          const browserContextId = z
            .string()
            .optional()
            .parse(command.params.browserContextId)
          const target: FixtureTarget = {
            title: targetId,
            url: "about:blank",
          }
          if (browserContextId) target.browserContextId = browserContextId
          targets.set(targetId, target)
          reply({ targetId })
          break
        }
        case "Target.getTargets":
          reply({
            targetInfos: Array.from(targets, ([targetId, info]) => ({
              targetId,
              type: info.type ?? "page",
              title: info.title,
              url: info.url,
              browserContextId: info.browserContextId,
            })),
          })
          break
        case "Target.getTargetInfo": {
          const id = z.string().parse(command.params.targetId)
          const info = targets.get(id)
          if (!info) fail("No target with given id")
          else
            reply({
              targetInfo: {
                targetId: id,
                type: info.type ?? "page",
                title: info.title,
                url: info.url,
                browserContextId: info.browserContextId,
              },
            })
          break
        }
        case "Target.attachToTarget": {
          const sessionId = `session-${++sequence}`
          sessions.set(sessionId, z.string().parse(command.params.targetId))
          reply({ sessionId })
          break
        }
        case "Target.detachFromTarget": {
          const sessionId = z.string().parse(command.params.sessionId)
          const targetId = sessions.get(sessionId)
          socket.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId, targetId, reason: "target_closed" } }))
          sessions.delete(sessionId)
          reply({})
          break
        }
        case "Target.closeTarget":
          targets.delete(z.string().parse(command.params.targetId))
          reply({ success: true })
          break
        case "Runtime.evaluate": {
          const expression = z.string().parse(command.params.expression)
          if (expression === "document.visibilityState")
            reply({ result: { value: page.hidden ? "hidden" : "visible" } })
          else if (expression.includes("width: window.innerWidth"))
            reply({ result: { value: { density: 2, width: 800, height: 600 } } })
          else if (expression === "window.devicePixelRatio")
            reply({ result: { value: 2 } })
          else if (expression.includes("window.scrollX"))
            reply({ result: { value: { x: page.scroll.x, y: page.scroll.y } } })
          else if (expression.includes("wantSelector"))
            reply({ result: { value: page.selectorPresent } })
          else if (command.params.contextId !== undefined)
            reply({
              result: { value: `frame-context-${command.params.contextId}` },
            })
          else if (expression.includes("big-result"))
            reply({ result: { value: "x".repeat(300_000) } })
          else if (expression.includes("document.activeElement"))
            reply({
              result: {
                value: page.activeEditable
                  ? { tag: "input", length: 3 }
                  : { tag: "div", length: -1 },
              },
            })
          else reply({ result: { value: tab } })
          break
        }
        case "DOM.resolveNode":
          reply({
            object: { objectId: `object-${command.params.backendNodeId}` },
          })
          break
        case "Runtime.callFunctionOn": {
          const source = z.string().parse(command.params.functionDeclaration)
          if (source.includes("typeof this.value")) {
            const backendId = Number(
              String(command.params.objectId).replace("object-", "")
            )
            const node = axNodes.find(
              (node) => node.backendDOMNodeId === backendId
            )
            reply({
              result: {
                value: node?.value
                  ? z.object({ value: z.string() }).parse(node.value).value
                  : "",
              },
            })
          } else if (source.includes("this.options")) {
            if (source.includes('"missing"'))
              reply({
                exceptionDetails: {
                  text: "Uncaught",
                  exception: {
                    description:
                      "Error: No option matches; options are: Red=r, Blue=b",
                  },
                },
              })
            else reply({ result: { value: { value: "b", label: "Blue" } } })
          } else if (source.includes("elementFromPoint")) {
            if (page.hidden)
              reply({
                exceptionDetails: {
                  text: "Uncaught",
                  exception: {
                    description:
                      "Error: Element is hidden or covered at its centre; observe again or use coordinates from a screenshot\n    at <anonymous>",
                  },
                },
              })
            else reply({ result: { value: { x: 40, y: 20 } } })
          } else if (source.includes("getBoundingClientRect"))
            reply({
              result: { value: { x: 10, y: 10, width: 100, height: 40 } },
            })
          else if (source.includes("activeElement")) {
            if (!page.editable)
              reply({
                exceptionDetails: {
                  text: "Uncaught",
                  exception: {
                    description:
                      "Error: Element <div> is not editable; choose a text field, textarea, select or contenteditable ref",
                  },
                },
              })
            else if (!page.focusTakes)
              reply({
                exceptionDetails: {
                  text: "Uncaught",
                  exception: {
                    description:
                      "Error: Element <input> did not take focus; click it first or use coordinates",
                  },
                },
              })
            else reply({ result: { value: { tag: "input", length: 3 } } })
          } else reply({ result: { value: null } })
          break
        }
        case "DOM.getDocument":
          reply({ root: { backendNodeId: 9999 } })
          break
        case "Accessibility.queryAXTree": {
          const root = axNodes.find(
            (node) => node.backendDOMNodeId === command.params.backendNodeId
          )
          const descendants = new Set<JsonValue>(
            root ? [root.nodeId] : axNodes.map((node) => node.nodeId)
          )
          if (root)
            for (let pass = 0; pass < axNodes.length; pass++)
              for (const node of axNodes)
                if (descendants.has(node.parentId ?? null))
                  descendants.add(node.nodeId)
          const nodes = axNodes.filter(
            (node) =>
              descendants.has(node.nodeId) &&
              (command.params.role === undefined ||
                z.object({ value: z.string() }).parse(node.role).value ===
                  command.params.role) &&
              (command.params.accessibleName === undefined ||
                z.object({ value: z.string() }).parse(node.name).value ===
                  command.params.accessibleName)
          )
          reply({ nodes })
          break
        }
        case "Accessibility.getFullAXTree":
          if (holdAxRead) {
            holdAxRead = false
            delayedAxRead = () => reply({ nodes: axNodes })
          } else reply({ nodes: axNodes })
          break
        case "Page.getLayoutMetrics":
          reply({
            cssContentSize: { x: 0, y: 0, width: 800, height: 2000 },
            cssVisualViewport: {
              pageX: 0,
              pageY: page.scroll.y,
              clientWidth: 800,
              clientHeight: 600,
            },
          })
          break
        case "Page.navigate": {
          const url = z.string().parse(command.params.url)
          if (url.includes("hang")) {
            reply({ frameId: "frame", loaderId: "loader-hang" })
            break
          }
          const loaderId = url.includes("redirect") ? "loader-a" : "loader"
          reply({ frameId: "frame", loaderId })
          const finalLoader = url.includes("redirect") ? "loader-b" : loaderId
          emit("Page.lifecycleEvent", {
            frameId: "frame",
            loaderId: finalLoader,
            name: "DOMContentLoaded",
          })
          if (!url.includes("slow"))
            emit("Page.lifecycleEvent", {
              frameId: "frame",
              loaderId: finalLoader,
              name: "load",
            })
          break
        }
        case "Page.captureScreenshot":
          reply({
            data: screenshotPixels,
          })
          break
        case "Page.handleJavaScriptDialog":
          page.dialogAnswers.push(command.params)
          if (page.nextDialog) {
            const message = page.nextDialog
            page.nextDialog = undefined
            emit("Page.javascriptDialogClosed", { result: command.params.accept === true })
            emit("Page.javascriptDialogOpening", { type: "confirm", message })
            reply({})
          } else {
            reply({})
            emit("Page.javascriptDialogClosed", {
              result: command.params.accept === true,
            })
          }
          break
        case "Page.setDownloadBehavior":
          page.downloadBehavior = command.params
          reply({})
          break
        case "Page.printToPDF":
          reply({ data: Buffer.from("%PDF-1.4 fixture").toString("base64") })
          break
        case "Network.getCookies":
          reply({ cookies: page.cookies })
          break
        case "Network.setCookies":
          page.cookies.push(
            ...z
              .array(z.record(z.string(), z.json()))
              .parse(command.params.cookies)
              .map((cookie) => ({
                domain: "example.test",
                path: "/",
                ...cookie,
              }))
          )
          if (holdCookies) { holdCookies = false; delayedCookies = () => reply({}) }
          else reply({})
          break
        case "Network.deleteCookies":
          page.cookies = page.cookies.filter(
            (cookie) => cookie.name !== command.params.name
          )
          reply({})
          break
        case "Network.clearBrowserCookies":
          page.cookies = []
          reply({})
          break
        case "Network.enable":
          reply({})
          break
        case "Page.getFrameTree":
          reply({
            frameTree: {
              frame: {
                id: "frame",
                url: "https://example.test/",
                securityOrigin: "https://example.test",
              },
              childFrames: [
                {
                  frame: {
                    id: "child",
                    parentId: "frame",
                    url: "https://example.test/embed",
                    name: "embed",
                  },
                },
              ],
            },
          })
          break
        case "Page.createIsolatedWorld":
          reply({ executionContextId: 77 })
          break
        case "Page.getNavigationHistory":
          reply({
            currentIndex: page.historyIndex,
            entries: page.history.map((url, index) => ({ id: index + 1, url })),
          })
          break
        case "Page.navigateToHistoryEntry":
          page.historyIndex = z.number().parse(command.params.entryId) - 1
          reply({})
          emit("Page.lifecycleEvent", {
            frameId: "frame",
            loaderId: "history",
            name: "load",
          })
          break
        case "Page.reload":
          reply({})
          emit("Page.lifecycleEvent", {
            frameId: "frame",
            loaderId: "reload",
            name: "load",
          })
          break
        case "Input.dispatchMouseEvent":
          if (command.params.type === "mouseReleased" && page.downloadOnClick) {
            page.downloadOnClick = false
            emit("Page.downloadWillBegin", {
              frameId: "frame",
              guid: "dl-1",
              url: "https://example.test/report.csv",
              suggestedFilename: "report.csv",
            })
            emit("Page.downloadProgress", {
              guid: "dl-1",
              totalBytes: 12,
              receivedBytes: 12,
              state: "completed",
            })
          }
          if (command.params.type === "mouseWheel")
            page.scroll = {
              x: page.scroll.x + z.number().parse(command.params.deltaX),
              y: page.scroll.y + z.number().parse(command.params.deltaY),
            }
          reply({})
          break
        case "Input.insertText":
          if (command.params.text === "delay") delayed = () => reply({})
          else reply({})
          break
        default:
          reply({})
      }
    })
  })
  return {
    definition: {
      id: "fixture",
      name: "Fixture Chrome",
      endpoint: async () => `ws://127.0.0.1:${port}/devtools/browser/fixture`,
    },
    connections: () => connections,
    calls,
    axNodes,
    targets,
    page,
    /** Hold one exact input acknowledgement, while still receiving other commands. */
    holdNextInput(type: HeldInputType) {
      let complete: ((error?: string) => void) | undefined
      const dispatched = new Promise<z.infer<typeof commandSchema>>((resolve) => {
        heldInputs.push({ type, dispatch(command, finish) { complete = finish; resolve(command) } })
      })
      return {
        dispatched,
        complete(error?: string) {
          if (!complete) throw new Error(`No pending ${type} acknowledgement`)
          const finish = complete
          complete = undefined
          finish(error)
        },
      }
    },
    setRecordingFrame: (frame: string) => { recordingFrame = frame },
    holdNextRecordingStop: () => { holdStop = true },
    completeRecordingStop: () => { delayedStop?.(); delayedStop = undefined },
    holdNextCookieWrite: () => { holdCookies = true },
    completeCookieWrite: () => { delayedCookies?.(); delayedCookies = undefined },
    holdNextAxRead: () => { holdAxRead = true },
    completeAxRead: () => { delayedAxRead?.(); delayedAxRead = undefined },
    completeDelayed: () => {
      delayed?.()
      delayed = undefined
    },
    /** Push a raw frame to every client, e.g. a malformed one. */
    broadcast(frame: string) {
      for (const socket of sockets) socket.send(frame)
    },
    /** Emit a protocol event on a session, e.g. a subframe navigation. */
    emit(sessionId: string, method: string, params: JsonObject) {
      for (const socket of sockets)
        socket.send(JSON.stringify({ method, sessionId, params }))
    },
    sessionFor(tab: string) {
      return [...sessions.entries()].find(([, target]) => target === tab)?.[0]
    },
    disconnect: () => {
      for (const socket of sockets) socket.terminate()
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
