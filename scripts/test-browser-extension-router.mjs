import assert from "node:assert/strict"
import { build } from "esbuild"
const built = await build({
  entryPoints: ["browser-extension/router.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
})
const { ExtensionRouter } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
)
const messages = []
const attached = new Set()
const created = []
const createdWindows = []
const sent = []
const targets = [
  {
    id: "page",
    tabId: 1,
    type: "page",
    title: "Fixture",
    url: "about:blank",
    attached: false,
  },
]
const api = {
  debugger: {
    getTargets: async () => targets,
    attach: async ({ targetId }) => {
      attached.add(targetId)
    },
    detach: async ({ targetId }) => {
      attached.delete(targetId)
    },
    sendCommand: async (target, method, params) => {
      sent.push({ target, method, params })
      return { proof: "fixture" }
    },
  },
  tabs: {
    create: async (options) => {
      created.push(options)
      targets.push({
        id: "new-page",
        tabId: 2,
        type: "page",
        title: "",
        url: options.url,
        attached: false,
      })
      return { id: 2 }
    },
    remove: async (tabId) => {
      const index = targets.findIndex((target) => target.tabId === tabId)
      if (index >= 0) targets.splice(index, 1)
    },
    update: async () => ({}),
  },
  windows: {
    create: async (options) => {
      createdWindows.push(options)
      const tab = {
        id: 3,
        windowId: 30,
        active: !options.focused,
        index: 0,
        pinned: false,
        highlighted: false,
        incognito: false,
      }
      targets.push({
        id: "window-page",
        tabId: tab.id,
        type: "page",
        title: "",
        url: options.url,
        attached: false,
      })
      return { id: 30, focused: options.focused, tabs: [tab] }
    },
  },
}
const router = new ExtensionRouter(api, (message) => messages.push(message))
const request = async (client, method, params = {}, sessionId) => {
  await router.request(client, {
    id: messages.length + 1,
    method,
    params,
    sessionId,
  })
  return messages.at(-1)
}
try {
  const unsupported = await request("a", "Browser.getVersion")
  assert.equal(unsupported.kind, "error")
  assert.match(unsupported.message, /does not expose/)
  const first = await request("a", "Target.attachToTarget", {
    targetId: "page",
  })
  assert.equal(first.kind, "response")
  const session = first.result.sessionId
  assert.equal(
    (await request("b", "Target.attachToTarget", { targetId: "page" })).kind,
    "error"
  )
  assert.equal(
    (await request("b", "Runtime.evaluate", {}, session)).kind,
    "error"
  )
  assert.deepEqual(sent, [])
  await request("a", "Runtime.evaluate", { expression: "1" }, session)
  assert.deepEqual(sent[0].target, { targetId: "page" })
  router.event({ tabId: 1 }, "Page.loadEventFired", { timestamp: 1 })
  assert.equal(messages.at(-1).client, "a")
  assert.equal(messages.at(-1).sessionId, session)
  await router.disconnect("a")
  assert.equal(attached.size, 0)
  assert.equal(
    (await request("a", "Runtime.evaluate", {}, session)).kind,
    "error"
  )
  const opened = await request("b", "Target.createTarget", {
    url: "about:blank",
  })
  assert.equal(opened.kind, "response")
  assert.equal(created[0].active, false)
  assert.equal(
    (await request("a", "Target.attachToTarget", { targetId: "new-page" }))
      .kind,
    "error"
  )
  assert.equal(
    (await request("a", "Target.closeTarget", { targetId: "new-page" })).kind,
    "error"
  )
  const attachedNew = await request("b", "Target.attachToTarget", {
    targetId: "new-page",
  })
  await request("b", "Target.detachFromTarget", {
    sessionId: attachedNew.result.sessionId,
  })
  await request("b", "Target.closeTarget", { targetId: "new-page" })
  assert.equal(targets.length, 1)
  const openedWindow = await request("window-owner", "Target.createTarget", {
    url: "about:blank",
    newWindow: true,
    background: true,
  })
  assert.equal(openedWindow.kind, "response")
  assert.equal(createdWindows[0].focused, false)
  await router.disconnect("window-owner")
  assert.equal(
    targets.some((target) => target.id === "window-page"),
    false,
    "an unattached temporary window closes when its client disappears"
  )
  let releaseAttach
  let beganAttach
  const began = new Promise((resolve) => {
    beganAttach = resolve
  })
  api.debugger.attach = async ({ targetId }) => {
    beganAttach()
    await new Promise((resolve) => {
      releaseAttach = resolve
    })
    attached.add(targetId)
  }
  const racing = request("c", "Target.attachToTarget", { targetId: "page" })
  await began
  await router.disconnect("c")
  releaseAttach()
  assert.equal((await racing).kind, "error")
  assert.equal(attached.size, 0)
  console.log(
    "Browser extension router: exact ownership, stale sessions, routed events, background tab/window creation, orphan cleanup, foreign close rejection and disconnect during attachment passed"
  )
} finally {
  await router.close()
}
