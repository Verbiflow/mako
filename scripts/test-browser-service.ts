import assert from "node:assert/strict"
import { z } from "zod"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
  BrowserFault,
} from "../packages/control-runtime/src/contracts/browser-control.js"
import { startControlService } from "../electron/control-service.js"
import { browserControlClient } from "../packages/control-runtime/src/browser-control-client.js"
import { browserFixture } from "./browser-control-fixture.js"

const discovered = [
  {
    id: "first",
    name: "First profile",
    endpoint: async () => "ws://127.0.0.1:1",
  },
]
const catalog = new BrowserService(discovered)
let catalogUpdates = 0
catalog.subscribe(() => {
  catalogUpdates++
})
assert.equal((await catalog.refresh()).length, 1)
assert.equal(catalogUpdates, 0)
discovered[0] = { ...discovered[0], name: "Renamed profile" }
assert.equal((await catalog.refresh())[0].name, "Renamed profile")
assert.equal(catalogUpdates, 1)
discovered.splice(0)
assert.deepEqual(await catalog.refresh(), [])
assert.equal(catalogUpdates, 2)
catalog.close()

let releaseDiscovery: (() => void) | undefined
let discoveryCalls = 0
const slowCatalog = new BrowserService(async () => {
  discoveryCalls++
  await new Promise<void>((resolve) => {
    releaseDiscovery = resolve
  })
  return [
    {
      id: "late",
      name: "Late profile",
      endpoint: async () => "ws://127.0.0.1:1",
    },
  ]
})
const firstRefresh = slowCatalog.refresh()
const secondRefresh = slowCatalog.refresh()
assert.equal(
  discoveryCalls,
  1,
  "Concurrent status reads share filesystem discovery"
)
slowCatalog.close()
releaseDiscovery?.()
await Promise.all([firstRefresh, secondRefresh])
assert.deepEqual(
  slowCatalog.status(),
  [],
  "Discovery finishing after shutdown must not resurrect a catalog"
)

const fixture = await browserFixture()
const attachedFixture = await browserFixture()
const service = new BrowserService([fixture.definition])
let authorized = true
const control = await startControlService(service, () => {
  if (!authorized) throw new Error("Binding is no longer active")
})
const credentials = control.mint("task-a", "binding-a")
const remote = browserControlClient({
  MAKO_CONTROL_URL: credentials.url,
  MAKO_CONTROL_TOKEN: credentials.token,
})
const run = (
  owner: string,
  input: Parameters<typeof BrowserCommandSchema.parse>[0],
  signal = new AbortController().signal
) => service.execute(owner, BrowserCommandSchema.parse(input), signal)
try {
  assert.equal(fixture.connections(), 0)
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      run(`task-${i}`, { action: "connect", browser: "fixture" })
    )
  )
  assert.equal(
    fixture.connections(),
    1,
    "Ten tasks must share one Chrome connection"
  )
  const attachedId = "app:dev.mako.fixture:4242:deadbeef"
  const attached = z.object({ id: z.literal(attachedId) }).parse(
    await run("task-a", {
      action: "attach",
      id: attachedId,
      name: "Attached fixture",
      endpoint: await attachedFixture.definition.endpoint(),
    })
  )
  assert.equal(attached.id, attachedId)
  await assert.rejects(
    run("task-b", {
      action: "attach",
      id: attachedId,
      name: "Collision",
      endpoint: await attachedFixture.definition.endpoint(),
    }),
    /another task/
  )
  await assert.rejects(run("task-b", { action: "detach", id: attachedId }), /another task/)
  await assert.rejects(run("task-b", { action: "tabs", browser: attachedId }), /another task/)
  await assert.rejects(run("task-b", {
    action: "attach", id: "app:dev.mako.alias:4242:feedbeef", name: "Alias",
    endpoint: await attachedFixture.definition.endpoint(),
  }), /already registered/)
  assert.deepEqual(await run("task-a", { action: "detach", id: attachedId }), {
    id: attachedId,
    detached: true,
  })
  assert.ok(
    !service.status().some((entry) => entry.id === attachedId),
    "detach removes the exact attached generation"
  )
  assert.deepEqual(await run("task-a", { action: "detach", id: attachedId }), {
    id: attachedId,
    detached: false,
  })
  const a = BrowserTargetSchema.parse(
    await run("task-a", { action: "open", browser: "fixture" })
  )
  const b = BrowserTargetSchema.parse(
    await run("task-b", {
      action: "open",
      browser: "fixture",
      lifetime: "persistent",
    })
  )
  assert.notEqual(a.tab, b.tab)
  assert.ok(
    fixture.calls
      .filter((call) => call.method === "Target.createTarget")
      .every((call) => call.params.background === true),
    "new tabs stay in the background unless activation is explicit"
  )
  assert.equal(
    fixture.calls.filter(
      (call) => call.method === "Emulation.setFocusEmulationEnabled"
    ).length,
    0,
    "an idle background binding must not claim page focus"
  )
  await Promise.all([
    run("task-a", { action: "type", target: a, text: "a" }),
    run("task-b", { action: "type", target: b, text: "b" }),
  ])
  const inputCalls = fixture.calls.filter(
    (call) => call.method === "Input.insertText"
  )
  assert.notEqual(inputCalls[0].sessionId, inputCalls[1].sessionId)
  for (const input of inputCalls) {
    const index = fixture.calls.indexOf(input)
    const before = fixture.calls
      .slice(0, index)
      .findLast(
        (call) =>
          call.sessionId === input.sessionId &&
          call.method === "Emulation.setFocusEmulationEnabled"
      )
    const after = fixture.calls
      .slice(index + 1)
      .find(
        (call) =>
          call.sessionId === input.sessionId &&
          call.method === "Emulation.setFocusEmulationEnabled"
      )
    assert.equal(
      before?.params.enabled,
      true,
      "focus emulation starts before hidden input"
    )
    assert.equal(
      after?.params.enabled,
      false,
      "focus emulation ends after hidden input"
    )
  }
  await assert.rejects(
    run("task-b", { action: "type", target: a, text: "wrong" }),
    /another task/
  )
  const rejectedBeforeDispatch = fixture.calls.length
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    run(
      "task-a",
      { action: "type", target: a, text: "cancelled" },
      cancelled.signal
    )
  )
  assert.equal(fixture.calls.length, rejectedBeforeDispatch)
  const delayedAbort = new AbortController()
  const delayed = run(
    "task-a",
    { action: "type", target: a, text: "delay" },
    delayedAbort.signal
  )
  const rejected = assert.rejects(
    delayed,
    (error: Error) =>
      error instanceof BrowserFault && error.detail.outcome === "unknown"
  )
  for (
    let count = 0;
    !fixture.calls.some((call) => call.params.text === "delay");
    count++
  ) {
    assert.ok(count < 100)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const concurrent = await run("task-a", {
    action: "cdp",
    target: a,
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    concurrent: true,
  })
  assert.ok(concurrent)
  await assert.rejects(
    run("task-b", {
      action: "select",
      browser: "fixture",
      tab: a.tab,
      takeover: true,
    }),
    /Another task/
  )
  delayedAbort.abort()
  await rejected
  await assert.rejects(
    run("task-a", { action: "type", target: a, text: "retry" }),
    /outcome is unknown/
  )
  fixture.emit(z.string().parse(fixture.sessionFor(a.tab)), "Page.javascriptDialogOpening", {
    type: "alert", message: "Action interrupted", url: "https://example.test",
  })
  for (let attempt = 0; ; attempt++) {
    const dialog = z.object({ pending: z.json().nullable() }).parse(
      await run("task-a", { action: "dialog", target: a })
    )
    if (dialog.pending !== null) break
    assert.ok(attempt < 100)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await run("task-a", { action: "dialog", target: a, respond: "dismiss" })
  await assert.rejects(
    run("task-a", { action: "type", target: a, text: "dialog-is-not-verification" }),
    /outcome is unknown/
  )
  fixture.completeDelayed()
  const stopPreview = await service.previewStream("task-a", a, () => {}, () => {}, () => {})
  await stopPreview()
  await assert.rejects(
    run("task-a", {
      action: "type",
      target: a,
      text: "preview-is-not-observation",
    }),
    /outcome is unknown/
  )
  const firstObservation = z
    .object({
      observation: z.string(),
      lineage: z.string(),
      nodes: z.array(z.object({ ref: z.string() })),
    })
    .parse(await run("task-a", { action: "observe", target: a }))
  fixture.axNodes[0] = { ...fixture.axNodes[0], backendDOMNodeId: 2 }
  const unchanged = await run("task-a", {
    action: "observe",
    target: a,
    since: firstObservation.observation,
  })
  assert.deepEqual(unchanged, {
    target: a,
    observation: firstObservation.observation,
    lineage: firstObservation.lineage,
    unchanged: true,
  })
  await run("task-a", {
    action: "type",
    target: a,
    ref: firstObservation.nodes[0]!.ref,
    text: "unchanged ref remains usable",
  })
  assert.equal(
    fixture.calls.filter((call) => call.method === "DOM.resolveNode").at(-1)
      ?.params.backendNodeId,
    2,
    "an unchanged semantic observation refreshes the old ref's live backend node"
  )
  await run("task-a", { action: "type", target: a, text: "after-observation" })
  const doomed = BrowserTargetSchema.parse(
    await run("task-doomed", { action: "open", browser: "fixture" })
  )
  const delayedCount = fixture.calls.filter(
    (call) => call.method === "Input.insertText" && call.params.text === "delay"
  ).length
  const doomedCall = run("task-doomed", {
    action: "type",
    target: doomed,
    text: "delay",
  })
  const doomedRejected = assert.rejects(
    doomedCall,
    (error: Error) =>
      error instanceof BrowserFault &&
      error.detail.code === "target-closed" &&
      error.detail.outcome === "unknown"
  )
  for (
    let count = 0;
    fixture.calls.filter(
      (call) =>
        call.method === "Input.insertText" && call.params.text === "delay"
    ).length === delayedCount;
    count++
  ) {
    assert.ok(count < 100)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  fixture.emit(fixture.sessionFor(doomed.tab), "Target.targetDestroyed", {
    targetId: doomed.tab,
  })
  fixture.completeDelayed()
  await doomedRejected
  const magnified = z
    .object({
      view: z.string(),
      clip: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        scale: z.number(),
      }),
      coordinates: z.object({
        viewportWidth: z.number(),
        viewportHeight: z.number(),
      }),
    })
    .parse(
      await run("task-a", {
        action: "screenshot",
        target: a,
        region: { x: 10, y: 20, width: 100, height: 50 },
      })
    )
  assert.deepEqual(magnified.clip, {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    scale: 0.5,
  })
  assert.deepEqual(magnified.coordinates, {
    viewportWidth: 800,
    viewportHeight: 600,
  })
  await run("task-a", {
    action: "click",
    target: a,
    at: { x: 40, y: 30, view: magnified.view },
  })
  await assert.rejects(
    run("task-a", {
      action: "click",
      target: a,
      at: { x: 40, y: 30, view: magnified.view },
    }),
    /earlier visual view/
  )
  await assert.rejects(
    run("task-a", {
      action: "screenshot",
      target: a,
      region: { x: 750, y: 20, width: 100, height: 50 },
    }),
    /outside the current viewport/
  )
  const originalNodes = fixture.axNodes.splice(0)
  fixture.axNodes.push(
    ...Array.from({ length: 100 }, (_, index) => ({
      nodeId: String(index + 1),
      ignored: false,
      backendDOMNodeId: index + 1,
      role: { value: "textbox" },
      name: { value: "🔥".repeat(10_000) },
      value: { value: "long value ".repeat(2_000) },
    }))
  )
  const bounded = await run("task-a", {
    action: "observe",
    target: a,
    maxNodes: 1000,
    since: firstObservation.observation,
  })
  const observation = z
    .object({
      observation: z.string(),
      nodes: z.array(
        z.object({ ref: z.string(), name: z.string(), value: z.string() })
      ),
      omitted: z.number(),
      truncatedTextFields: z.number(),
    })
    .parse(bounded)
  assert.notEqual(observation.observation, firstObservation.observation)
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded)) <= 60_000,
    "actual UTF-8 result fits the tool text budget"
  )
  assert.ok(observation.omitted > 0)
  assert.ok(observation.truncatedTextFields > 0)
  assert.ok(observation.nodes[0].name.length < 510)
  await run("task-a", {
    action: "type",
    target: a,
    ref: observation.nodes[0].ref,
    text: "bounded ref remains usable",
  })
  fixture.axNodes.splice(
    0,
    fixture.axNodes.length,
    {
      nodeId: "shipping",
      ignored: false,
      backendDOMNodeId: 501,
      role: { value: "form" },
      name: { value: "Shipping" },
    },
    {
      nodeId: "billing",
      ignored: false,
      backendDOMNodeId: 502,
      role: { value: "form" },
      name: { value: "Billing" },
    },
    {
      nodeId: "ship-email",
      parentId: "shipping",
      ignored: false,
      backendDOMNodeId: 503,
      role: { value: "textbox" },
      name: { value: "Email" },
    },
    {
      nodeId: "bill-email",
      parentId: "billing",
      ignored: false,
      backendDOMNodeId: 504,
      role: { value: "textbox" },
      name: { value: "Email" },
      value: { value: "untouched" },
    }
  )
  const scopedStart = fixture.calls.length
  const scopedResult = z
    .object({
      nodes: z.array(z.object({ name: z.string(), value: z.string() })),
      omitted: z.number(),
    })
    .parse(
      await run("task-a", {
        action: "observe",
        target: a,
        within: [{ role: "form", name: "Shipping" }],
        match: { role: "textbox", name: "Email" },
        maxNodes: 2,
      })
    )
  assert.deepEqual(
    scopedResult.nodes.map((node) => [node.name, node.value]),
    [["Email", ""]]
  )
  assert.equal(scopedResult.omitted, 0)
  assert.ok(
    !fixture.calls
      .slice(scopedStart)
      .some((call) =>
        [
          "Accessibility.getFullAXTree",
          "Page.getLayoutMetrics",
          "Page.captureScreenshot",
        ].includes(call.method)
      ),
    "targeted read does not fetch the whole tree, layout, or screenshot"
  )
  const subtree = z
    .object({ nodes: z.array(z.object({ role: z.string() })) })
    .parse(
      await run("task-a", {
        action: "observe",
        target: a,
        within: [{ role: "form", name: "Shipping" }],
      })
    )
  assert.deepEqual(
    subtree.nodes.map((node) => node.role),
    ["textbox"],
    "within returns descendants, matching local and native scope semantics"
  )

  fixture.page.hidden = true
  const hiddenStart = fixture.calls.length
  const hiddenResult = z
    .object({ nodes: z.array(z.object({ value: z.string() })) })
    .parse(
      await run("task-a", {
        action: "observe",
        target: a,
        within: [{ role: "form", name: "Shipping" }],
        match: { role: "textbox", name: "Email" },
      })
    )
  assert.deepEqual(
    hiddenResult.nodes.map((node) => node.value),
    [""]
  )
  assert.ok(
    fixture.calls
      .slice(hiddenStart)
      .some((call) => call.method === "Accessibility.getFullAXTree")
  )
  assert.ok(
    !fixture.calls
      .slice(hiddenStart)
      .some((call) =>
        [
          "Accessibility.queryAXTree",
          "Page.captureScreenshot",
          "Target.activateTarget",
          "Emulation.setFocusEmulationEnabled",
        ].includes(call.method)
      ),
    "hidden scoped read neither waits for painting nor changes focus"
  )
  fixture.page.hidden = false
  fixture.axNodes.push({
    nodeId: "duplicate",
    ignored: false,
    backendDOMNodeId: 505,
    role: { value: "form" },
    name: { value: "Shipping" },
  })
  await assert.rejects(
    run("task-a", {
      action: "observe",
      target: a,
      within: [{ role: "form", name: "Shipping" }],
    }),
    /found 2/
  )
  fixture.axNodes.splice(0, fixture.axNodes.length, ...originalNodes)
  await run("task-a", { action: "observe", target: a })
  await assert.rejects(
    run("task-a", {
      action: "type",
      target: a,
      ref: observation.nodes[0].ref,
      text: "stale",
    }),
    /reference|ref|observation/i
  )
  assert.equal(
    fixture.calls.filter((call) => call.params.text === "delay").length,
    2,
    "each of the two uncertain actions was dispatched exactly once"
  )
  fixture.holdNextAxRead()
  const readStart = fixture.calls.length
  const overlapped = run("task-a", { action: "observe", target: a })
  const readRejected = assert.rejects(overlapped, /overlapped a mutation/)
  for (let attempt = 0; !fixture.calls.slice(readStart).some((call) => call.method === "Accessibility.getFullAXTree"); attempt++) {
    assert.ok(attempt < 100, "observation reached the driver")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await run("task-a", { action: "cdp", target: a, method: "Runtime.evaluate", params: { expression: "document.title" }, concurrent: true })
  fixture.completeAxRead()
  await readRejected
  await assert.rejects(run("task-a", { action: "type", target: a, text: "stale-read" }), /outcome is unknown/)
  await run("task-a", { action: "observe", target: a })
  fixture.targets.delete(a.tab)
  await assert.rejects(
    run("task-a", { action: "type", target: a, text: "closed" }),
    /No command was retried/
  )
  // The closed session is detected while checking the focused field, so no
  // text is ever dispatched to it.
  assert.equal(
    fixture.calls.filter((call) => call.params.text === "closed").length,
    0
  )
  assert.ok(!fixture.calls.some((call) => call.params.text === "wrong"))
  await run("task-b", { action: "type", target: b, text: "b-still-works" })
  const old = b
  await run("task-b", { action: "release", target: b })
  const contenders = await Promise.allSettled([
    run("task-c", { action: "select", browser: "fixture", tab: b.tab }),
    run("task-d", { action: "select", browser: "fixture", tab: b.tab }),
  ])
  assert.equal(
    contenders.filter((result) => result.status === "fulfilled").length,
    1
  )
  const reclaimed = BrowserTargetSchema.parse(
    await run("task-b", {
      action: "select",
      browser: "fixture",
      tab: b.tab,
      takeover: true,
    })
  )
  assert.notEqual(reclaimed.lease, old.lease)
  await assert.rejects(
    run("task-b", { action: "type", target: old, text: "old-lease" }),
    /earlier claim/
  )
  assert.equal(fixture.connections(), 1)
  await remote({ action: "status" }, new AbortController().signal)
  const replacementCredentials = control.mint("task-a", "binding-a")
  const replaced = browserControlClient({
    MAKO_CONTROL_URL: replacementCredentials.url,
    MAKO_CONTROL_TOKEN: replacementCredentials.token,
  })
  await replaced({ action: "status" }, new AbortController().signal)
  const revokedCredentials = control.mint("task-revoked", "binding-revoked")
  const revoked = browserControlClient({
    MAKO_CONTROL_URL: revokedCredentials.url,
    MAKO_CONTROL_TOKEN: revokedCredentials.token,
  })
  await revoked({ action: "status" }, new AbortController().signal)
  await control.revoke("task-revoked", "binding-revoked")
  await assert.rejects(
    revoked({ action: "status" }, new AbortController().signal),
    /no longer active/i,
    "a hibernated binding cannot reuse its control credential"
  )
  const failedDestinationCredentials = control.mint(
    "task-a",
    "binding-failed-destination"
  )
  const failedDestination = browserControlClient({
    MAKO_CONTROL_URL: failedDestinationCredentials.url,
    MAKO_CONTROL_TOKEN: failedDestinationCredentials.token,
  })
  await failedDestination({ action: "status" }, new AbortController().signal)
  const failedDestinationTarget = BrowserTargetSchema.parse(
    await failedDestination(
      { action: "open", browser: "fixture" },
      new AbortController().signal
    )
  )
  await control.revoke("task-a", "binding-failed-destination")
  assert.equal(
    fixture.targets.has(failedDestinationTarget.tab),
    false,
    "revoking a failed binding removes only that binding's browser resources"
  )
  await replaced({ action: "status" }, new AbortController().signal)
  assert.equal(
    fixture.connections(),
    1,
    "Replacing an MCP client must not disconnect Chrome"
  )
  const remoteTemporary = BrowserTargetSchema.parse(
    await remote(
      BrowserCommandSchema.parse({ action: "open", browser: "fixture" }),
      new AbortController().signal
    )
  )
  assert.equal(fixture.targets.has(remoteTemporary.tab), true)
  await remote.close()
  assert.equal(
    fixture.targets.has(remoteTemporary.tab),
    true,
    "a superseded control client cannot clean up its replacement"
  )
  await replaced.close()
  assert.equal(
    fixture.targets.has(remoteTemporary.tab),
    false,
    "closing a control client removes its task-lifetime browser resources"
  )
  assert.equal(
    service.status()[0].connection.status,
    "connected",
    "owner cleanup retains the shared browser connection"
  )
  authorized = false
  await assert.rejects(
    remote(
      { action: "tabs", browser: "fixture" },
      new AbortController().signal
    ),
    /no longer active/
  )
  service.disconnect("fixture")
  assert.equal(service.status()[0].connection.status, "disconnected")
  await run("task-b", { action: "connect", browser: "fixture" })
  await assert.rejects(
    run("task-b", {
      action: "type",
      target: reclaimed,
      text: "stale-generation",
    }),
    /earlier browser connection/
  )
  assert.equal(fixture.connections(), 2)

  // Input fidelity, observation quality, navigation waits and transport
  // tolerance, all against the fixture's recorded protocol traffic.
  const c = BrowserTargetSchema.parse(
    await run("task-c", { action: "open", browser: "fixture" })
  )
  const sessionC = fixture.sessionFor(c.tab)
  assert.ok(sessionC)
  fixture.axNodes.splice(
    0,
    fixture.axNodes.length,
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Fixture" },
    },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "generic" } },
    {
      nodeId: "3",
      parentId: "2",
      ignored: false,
      backendDOMNodeId: 3,
      role: { value: "checkbox" },
      name: { value: "Agree" },
      properties: [
        { name: "checked", value: { value: "true" } },
        { name: "focusable", value: { value: "true" } },
      ],
    },
    {
      nodeId: "4",
      parentId: "2",
      ignored: false,
      backendDOMNodeId: 4,
      role: { value: "button" },
      name: { value: "Submit" },
      properties: [{ name: "disabled", value: { value: "true" } }],
    },
    {
      nodeId: "5",
      parentId: "2",
      ignored: false,
      backendDOMNodeId: 5,
      role: { value: "StaticText" },
      name: { value: "Terms apply" },
    },
    {
      nodeId: "6",
      parentId: "5",
      ignored: false,
      backendDOMNodeId: 6,
      role: { value: "InlineTextBox" },
      name: { value: "Terms apply" },
    },
    {
      nodeId: "7",
      parentId: "2",
      ignored: false,
      backendDOMNodeId: 7,
      role: { value: "link" },
      name: { value: "Help" },
      properties: [
        { name: "url", value: { value: "https://example.test/help" } },
      ],
    },
    {
      nodeId: "8",
      parentId: "2",
      ignored: false,
      backendDOMNodeId: 8,
      role: { value: "heading" },
      name: { value: "Section" },
      properties: [{ name: "level", value: { value: "2" } }],
    }
  )
  const observed = z
    .object({
      nodes: z.array(z.record(z.string(), z.json())),
      viewport: z.object({
        width: z.number(),
        height: z.number(),
        scrollY: z.number(),
        pagesBelow: z.number(),
      }),
      matched: z.number(),
      offset: z.number(),
      nextOffset: z.number().nullable(),
    })
    .parse(await run("task-c", { action: "observe", target: c }))
  assert.equal(observed.viewport.width, 800)
  assert.equal(observed.viewport.pagesBelow, 2.3)
  const roles = observed.nodes.map((node) => node.role)
  assert.ok(
    !roles.includes("InlineTextBox"),
    "text runs are folded into their StaticText"
  )
  assert.ok(!roles.includes("generic"), "unnamed wrappers are dropped")
  const checkbox = observed.nodes.find((node) => node.role === "checkbox")
  assert.equal(checkbox?.checked, "true")
  assert.equal(
    observed.nodes.find((node) => node.role === "button")?.disabled,
    "true"
  )
  assert.equal(
    observed.nodes.find((node) => node.role === "link")?.url,
    "https://example.test/help"
  )
  assert.equal(observed.nodes.find((node) => node.role === "heading")?.level, 2)
  assert.equal(
    observed.nodes.find((node) => node.role === "StaticText")?.depth,
    2
  )
  assert.match(String(checkbox?.ref), /^[0-9a-f]{6}:\d+$/)
  const interactive = z
    .object({
      nodes: z.array(z.object({ role: z.string() })),
      matched: z.number(),
    })
    .parse(
      await run("task-c", {
        action: "observe",
        target: c,
        interactiveOnly: true,
      })
    )
  assert.deepEqual(interactive.nodes.map((node) => node.role).sort(), [
    "button",
    "checkbox",
    "link",
  ])
  const paged = z
    .object({
      nodes: z.array(z.object({ role: z.string() })),
      nextOffset: z.number().nullable(),
      offset: z.number(),
      omitted: z.number(),
    })
    .parse(
      await run("task-c", {
        action: "observe",
        target: c,
        maxNodes: 2,
        offset: 1,
      })
    )
  assert.equal(paged.offset, 1)
  assert.equal(paged.nodes.length, 2)
  assert.equal(paged.nextOffset, 3)
  assert.equal(paged.omitted, 3)
  const queried = z
    .object({
      nodes: z.array(z.object({ role: z.string(), name: z.string() })),
    })
    .parse(await run("task-c", { action: "observe", target: c, query: "help" }))
  assert.deepEqual(
    queried.nodes.map((node) => node.name),
    ["Help"]
  )

  // Click: pointer move, press with a buttons mask, then release.
  const fresh = z
    .object({
      nodes: z.array(
        z.object({ ref: z.string().optional(), role: z.string() })
      ),
    })
    .parse(await run("task-c", { action: "observe", target: c }))
  const checkboxRef = fresh.nodes.find((node) => node.role === "checkbox")?.ref
  assert.ok(checkboxRef)
  const before = fixture.calls.length
  await run("task-c", {
    action: "click",
    target: c,
    at: { ref: checkboxRef },
    modifiers: ["Shift"],
  })
  const mouse = fixture.calls
    .slice(before)
    .filter((call) => call.method === "Input.dispatchMouseEvent")
  assert.deepEqual(
    mouse.map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"]
  )
  assert.equal(mouse[1].params.buttons, 1)
  assert.equal(mouse[1].params.modifiers, 8)
  assert.equal(mouse[2].params.buttons, 0)
  assert.deepEqual([mouse[1].params.x, mouse[1].params.y], [40, 20])
  const scrolled = fixture.calls
    .slice(before)
    .find((call) => call.method === "Runtime.callFunctionOn")
  assert.match(
    String(scrolled?.params.functionDeclaration),
    /behavior:'instant'/
  )
  fixture.page.hidden = true
  await assert.rejects(
    run("task-c", { action: "click", target: c, at: { ref: checkboxRef } }),
    /hidden or covered/
  )
  assert.equal(
    fixture.calls
      .filter(
        (call) =>
          call.sessionId === fixture.sessionFor(c.tab) &&
          call.method === "Emulation.setFocusEmulationEnabled"
      )
      .at(-1)?.params.enabled,
    false,
    "failed input must release target-local focus emulation"
  )
  fixture.page.hidden = false

  // Hover and scroll are real pointer events; scroll reports the new position.
  const hovered = fixture.calls.length
  await run("task-c", { action: "hover", target: c, at: { x: 5, y: 6 } })
  assert.deepEqual(
    fixture.calls
      .slice(hovered)
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => [call.params.type, call.params.x]),
    [["mouseMoved", 5]]
  )
  const scroll = z
    .object({ x: z.number(), y: z.number(), scrollY: z.number() })
    .parse(await run("task-c", { action: "scroll", target: c, deltaY: 300 }))
  assert.deepEqual([scroll.x, scroll.y, scroll.scrollY], [400, 300, 300])
  const wheel = fixture.calls.findLast(
    (call) => call.method === "Input.dispatchMouseEvent"
  )
  assert.equal(wheel?.params.type, "mouseWheel")
  assert.equal(wheel?.params.deltaY, 300)

  // Type: refuses a non-editable target, replaces the selected value with one edit, submits with Enter.
  fixture.page.editable = false
  await assert.rejects(
    run("task-c", { action: "type", target: c, ref: checkboxRef, text: "x" }),
    /not editable/
  )
  fixture.page.editable = true
  const typing = fixture.calls.length
  const typed = z
    .object({
      field: z.string(),
      cleared: z.number(),
      inserted: z.number(),
      submitted: z.boolean(),
    })
    .parse(
      await run("task-c", {
        action: "type",
        target: c,
        ref: checkboxRef,
        text: "hello",
        clear: true,
        submit: true,
      })
    )
  assert.deepEqual(typed, {
    field: "input",
    cleared: 3,
    inserted: 5,
    submitted: true,
  })
  const keys = fixture.calls
    .slice(typing)
    .filter((call) => call.method === "Input.dispatchKeyEvent")
    .map(
      (call) =>
        `${call.params.type}:${call.params.key}${call.params.commands ? ":" + JSON.stringify(call.params.commands) : ""}`
    )
  assert.deepEqual(keys, [
    'rawKeyDown:a:["selectAll"]',
    "keyUp:a",
    "keyDown:Enter",
    "keyUp:Enter",
  ])
  assert.ok(
    fixture.calls
      .slice(typing)
      .some(
        (call) =>
          call.method === "Input.insertText" && call.params.text === "hello"
      )
  )
  fixture.page.activeEditable = false
  await assert.rejects(
    run("task-c", { action: "type", target: c, text: "nowhere" }),
    /not editable|No element has focus/
  )
  fixture.page.activeEditable = true

  // Press: named keys, printable keys and modifier masks.
  const pressing = fixture.calls.length
  await run("task-c", { action: "press", target: c, key: "Enter" })
  await run("task-c", {
    action: "press",
    target: c,
    key: "l",
    modifiers: ["Meta"],
  })
  await run("task-c", { action: "press", target: c, key: "ArrowDown" })
  const pressed = fixture.calls
    .slice(pressing)
    .filter((call) => call.method === "Input.dispatchKeyEvent")
  assert.deepEqual(
    pressed.map((call) => [
      call.params.type,
      call.params.windowsVirtualKeyCode,
      call.params.modifiers,
    ]),
    [
      ["keyDown", 13, 0],
      ["keyUp", 13, 0],
      ["keyDown", 76, 4],
      ["keyUp", 76, 4],
      ["rawKeyDown", 40, 0],
      ["keyUp", 40, 0],
    ]
  )
  assert.equal(pressed[0].params.text, "\r")
  await assert.rejects(
    run("task-c", { action: "press", target: c, key: "Bogus" }),
    /Unknown key/
  )

  // Events are bounded by limit and report continuation.
  for (let index = 0; index < 40; index++)
    fixture.emit(sessionC, "Runtime.consoleAPICalled", {
      args: [String(index)],
    })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const firstPage = z
    .object({
      events: z.array(z.object({ cursor: z.number() })),
      cursor: z.number(),
      more: z.boolean(),
    })
    .parse(await run("task-c", { action: "events", target: c, limit: 10 }))
  assert.equal(firstPage.events.length, 10)
  assert.equal(firstPage.more, true)
  const secondPage = z
    .object({
      events: z.array(z.object({ cursor: z.number() })),
      more: z.boolean(),
    })
    .parse(
      await run("task-c", {
        action: "events",
        target: c,
        after: firstPage.cursor,
        limit: 128,
      })
    )
  assert.ok(secondPage.events.length >= 30)
  assert.ok(secondPage.events[0].cursor > firstPage.cursor)

  // A subframe navigation keeps refs; a main-frame navigation drops them.
  fixture.emit(sessionC, "Page.frameNavigated", {
    frame: { id: "child", parentId: "frame", url: "https://ads.test" },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await run("task-c", { action: "hover", target: c, at: { ref: checkboxRef } })
  fixture.emit(sessionC, "Page.frameNavigated", {
    frame: { id: "frame", url: "https://example.test/next" },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await assert.rejects(
    run("task-c", { action: "hover", target: c, at: { ref: checkboxRef } }),
    /latest observation/
  )

  // Navigation waits: redirects count, domcontentloaded returns early, a hang reports timeout.
  const redirected = z.object({ completion: z.string() }).parse(
    await run("task-c", {
      action: "navigate",
      target: c,
      url: "https://example.test/redirect",
    })
  )
  assert.equal(redirected.completion, "load")
  const early = z.object({ completion: z.string() }).parse(
    await run("task-c", {
      action: "navigate",
      target: c,
      url: "https://example.test/slow",
      waitUntil: "domcontentloaded",
    })
  )
  assert.equal(early.completion, "domcontentloaded")
  const hung = z.object({ completion: z.string(), note: z.string() }).parse(
    await run("task-c", {
      action: "navigate",
      target: c,
      url: "https://example.test/hang",
      timeoutMs: 1000,
    })
  )
  assert.equal(hung.completion, "timeout")
  await run("task-c", { action: "observe", target: c })
  await assert.rejects(
    run("task-c", {
      action: "navigate",
      target: c,
      url: "javascript:alert(1)",
    }),
    /http, https, about and data/
  )
  await assert.rejects(
    run("task-c", {
      action: "cdp",
      target: c,
      method: "Page.navigate",
      params: { url: "file:///etc/passwd" },
    }),
    /http, https, about and data/
  )

  // A malformed frame is dropped without tearing down the shared connection.
  fixture.broadcast("not json")
  fixture.broadcast(
    JSON.stringify({ method: "Odd.event", sessionId: sessionC, params: [1, 2] })
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(service.status()[0].connection.status, "connected")
  await run("task-c", { action: "observe", target: c })
  assert.equal(fixture.connections(), 2)

  // Worker targets are listed but cannot be selected as pages.
  fixture.targets.set("worker-1", {
    title: "worker",
    url: "https://example.test/sw.js",
    type: "service_worker",
  })
  const listed = z
    .array(z.object({ targetId: z.string(), selectable: z.boolean() }))
    .parse(await run("task-c", { action: "tabs", browser: "fixture" }))
  assert.equal(
    listed.find((tab) => tab.targetId === "worker-1")?.selectable,
    false
  )
  await assert.rejects(
    run("task-c", { action: "select", browser: "fixture", tab: "worker-1" }),
    /not a page/
  )

  // Dialogs: an open dialog blocks actions until answered; auto policy answers later ones.
  fixture.emit(sessionC, "Page.javascriptDialogOpening", {
    type: "confirm",
    message: "Leave page?",
    url: "https://example.test",
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await assert.rejects(
    run("task-c", { action: "observe", target: c }),
    /confirm dialog is open/
  )
  const pendingDialog = z
    .object({
      pending: z.object({ type: z.string(), message: z.string() }).nullable(),
      auto: z.string(),
    })
    .parse(await run("task-c", { action: "dialog", target: c }))
  assert.equal(pendingDialog.pending?.message, "Leave page?")
  const answered = z
    .object({ pending: z.null(), answered: z.object({ respond: z.string() }) })
    .parse(
      await run("task-c", {
        action: "dialog",
        target: c,
        respond: "accept",
        promptText: "yes",
      })
    )
  assert.equal(answered.answered.respond, "accept")
  assert.deepEqual(fixture.page.dialogAnswers.at(-1), {
    accept: true,
    promptText: "yes",
  })
  await run("task-c", { action: "observe", target: c })
  await run("task-c", { action: "dialog", target: c, auto: "dismiss" })
  fixture.emit(sessionC, "Page.javascriptDialogOpening", {
    type: "alert",
    message: "Auto",
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(fixture.page.dialogAnswers.at(-1), { accept: false })
  await run("task-c", { action: "observe", target: c })
  const autoEvents = z
    .object({
      events: z.array(
        z.object({ method: z.string(), params: z.record(z.string(), z.json()) })
      ),
    })
    .parse(await run("task-c", { action: "events", target: c, limit: 128 }))
  assert.ok(
    autoEvents.events.some(
      (event) =>
        event.method === "mako.dialogAutoHandled" &&
        event.params.message === "Auto"
    )
  )
  await assert.rejects(
    run("task-c", { action: "dialog", target: c, respond: "accept" }),
    /No dialog is open/
  )

  // Downloads: behaviour set to the directory, the click starts it, completion is awaited.
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const downloads = await mkdtemp(join(tmpdir(), "mako-browser-download-"))
  try {
    fixture.page.downloadOnClick = true
    await writeFile(join(downloads, "report.csv"), "a,b,c\n1,2,3\n")
    const saved = z
      .object({
        state: z.string(),
        suggestedFilename: z.string(),
        path: z.string(),
        bytes: z.number(),
      })
      .parse(
        await run("task-c", {
          action: "download",
          target: c,
          directory: downloads,
          at: { x: 5, y: 5 },
          timeoutMs: 2000,
        })
      )
    assert.equal(saved.state, "completed")
    assert.equal(saved.path, join(downloads, "report.csv"))
    assert.equal(saved.bytes, 12)
    assert.deepEqual(fixture.page.downloadBehavior, {
      behavior: "allow",
      downloadPath: downloads,
    })
    await assert.rejects(
      run("task-c", {
        action: "download",
        target: c,
        directory: join(downloads, "missing"),
        at: { x: 1, y: 1 },
      }),
      /not an existing directory/
    )
    await assert.rejects(
      run("task-c", {
        action: "download",
        target: c,
        directory: downloads,
        at: { x: 1, y: 1 },
        timeoutMs: 1000,
      }),
      /No download started/
    )
    await run("task-c", { action: "observe", target: c })
    // PDF lands at the requested path.
    const pdf = z.object({ path: z.string(), bytes: z.number() }).parse(
      await run("task-c", {
        action: "pdf",
        target: c,
        path: join(downloads, "page.pdf"),
        landscape: true,
      })
    )
    assert.equal(pdf.bytes, Buffer.byteLength("%PDF-1.4 fixture"))
    const printed = fixture.calls.findLast(
      (call) => call.method === "Page.printToPDF"
    )
    assert.equal(printed?.params.landscape, true)
    assert.equal(printed?.params.paperWidth, undefined)
    await assert.rejects(
      run("task-c", { action: "pdf", target: c, path: "relative.pdf" }),
      /absolute/
    )
  } finally {
    await rm(downloads, { recursive: true, force: true })
  }

  // Cookies: values stay out of a listing unless asked for.
  await run("task-c", {
    action: "cookies",
    target: c,
    operation: "set",
    cookies: [
      { name: "session", value: "secret-value", domain: "example.test" },
    ],
  })
  const listing = z
    .object({ cookies: z.array(z.record(z.string(), z.json())) })
    .parse(
      await run("task-c", { action: "cookies", target: c, operation: "list" })
    )
  assert.equal(listing.cookies[0].name, "session")
  assert.equal(listing.cookies[0].value, undefined)
  assert.equal(listing.cookies[0].valueLength, "secret-value".length)
  const withValues = z
    .object({ cookies: z.array(z.object({ value: z.string() })) })
    .parse(
      await run("task-c", {
        action: "cookies",
        target: c,
        operation: "list",
        includeValues: true,
      })
    )
  assert.equal(withValues.cookies[0].value, "secret-value")
  await assert.rejects(
    run("task-c", {
      action: "cookies",
      target: c,
      operation: "set",
      cookies: [{ name: "x", value: "y" }],
    }),
    /needs url or domain/
  )
  await run("task-c", {
    action: "cookies",
    target: c,
    operation: "delete",
    name: "session",
  })
  assert.deepEqual(fixture.page.cookies, [])

  // Frames and frame-scoped observation and evaluation.
  const frames = z
    .object({
      frames: z.array(
        z.object({
          id: z.string(),
          parentId: z.string().nullable(),
          depth: z.number(),
        })
      ),
    })
    .parse(await run("task-c", { action: "frames", target: c }))
  assert.deepEqual(
    frames.frames.map((frame) => [frame.id, frame.depth]),
    [
      ["frame", 0],
      ["child", 1],
    ]
  )
  await run("task-c", { action: "observe", target: c, frameId: "child" })
  assert.equal(
    fixture.calls.findLast(
      (call) => call.method === "Accessibility.getFullAXTree"
    )?.params.frameId,
    "child"
  )
  const inFrame = z.object({ result: z.object({ value: z.string() }) }).parse(
    await run("task-c", {
      action: "evaluate",
      target: c,
      expression: "document.title",
      frameId: "child",
    })
  )
  assert.equal(inFrame.result.value, "frame-context-77")

  // wait: selector polling, network idle, and a false result at timeout.
  fixture.page.selectorPresent = false
  const missed = z
    .object({ satisfied: z.boolean(), elapsedMs: z.number() })
    .parse(
      await run("task-c", {
        action: "wait",
        target: c,
        for: { selector: "#late" },
        timeoutMs: 300,
      })
    )
  assert.equal(missed.satisfied, false)
  fixture.page.selectorPresent = true
  const found = z.object({ satisfied: z.boolean() }).parse(
    await run("task-c", {
      action: "wait",
      target: c,
      for: { selector: "#late", url: "about" },
      timeoutMs: 2000,
    })
  )
  assert.equal(found.satisfied, true)
  fixture.emit(sessionC, "Network.requestWillBeSent", { requestId: "r1" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const busy = z.object({ satisfied: z.boolean() }).parse(
    await run("task-c", {
      action: "wait",
      target: c,
      for: { networkIdle: true },
      timeoutMs: 400,
    })
  )
  assert.equal(busy.satisfied, false)
  fixture.emit(sessionC, "Network.loadingFinished", { requestId: "r1" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const quiet = z.object({ satisfied: z.boolean() }).parse(
    await run("task-c", {
      action: "wait",
      target: c,
      for: { networkIdle: true },
      timeoutMs: 2000,
    })
  )
  assert.equal(quiet.satisfied, true)
  assert.ok(fixture.calls.some((call) => call.method === "Network.enable"))

  // History: back, forward past the end, reload.
  const back = z
    .object({ moved: z.boolean(), completion: z.string(), url: z.string() })
    .parse(await run("task-c", { action: "history", target: c, go: "back" }))
  assert.deepEqual(
    [back.moved, back.completion, back.url],
    [true, "load", "https://example.test/one"]
  )
  const forward = z
    .object({ moved: z.boolean(), url: z.string() })
    .parse(await run("task-c", { action: "history", target: c, go: "forward" }))
  assert.equal(forward.url, "https://example.test/two")
  const past = z
    .object({ moved: z.boolean() })
    .parse(await run("task-c", { action: "history", target: c, go: "forward" }))
  assert.equal(past.moved, false)
  const reloaded = z
    .object({ moved: z.boolean(), completion: z.string() })
    .parse(await run("task-c", { action: "history", target: c, go: "reload" }))
  assert.equal(reloaded.completion, "load")

  // selectOption picks by value or label and explains a miss (fresh ref: the
  // main-frame navigation above replaced the earlier observation).
  const selectRef = z
    .object({ nodes: z.array(z.object({ ref: z.string().optional() })) })
    .parse(await run("task-c", { action: "observe", target: c }))
    .nodes.find((node) => node.ref)?.ref
  assert.ok(selectRef)
  const picked = z.object({ value: z.string(), label: z.string() }).parse(
    await run("task-c", {
      action: "selectOption",
      target: c,
      ref: selectRef,
      label: "Blue",
    })
  )
  assert.deepEqual(picked, { value: "b", label: "Blue" })
  await assert.rejects(
    run("task-c", {
      action: "selectOption",
      target: c,
      ref: selectRef,
      value: "missing",
    }),
    /options are: Red=r, Blue=b/
  )
  await assert.rejects(
    run("task-c", { action: "selectOption", target: c, ref: selectRef }),
    /Pass value or label/
  )
  assert.equal(
    fixture.calls.filter((call) => call.method === "Target.activateTarget")
      .length,
    0,
    "no page recovery path may activate the user's physical tab"
  )
  const temporaryWindow = BrowserTargetSchema.parse(
    await run("lifecycle-owner", {
      action: "open",
      browser: "fixture",
      disposition: "window",
    })
  )
  assert.equal(
    fixture.calls.filter((call) => call.method === "Target.createTarget").at(-1)
      ?.params.newWindow,
    true
  )
  await run("lifecycle-owner", {
    action: "release",
    target: temporaryWindow,
  })
  const lifecycleTabs = z
    .array(z.object({ targetId: z.string(), claimed: z.boolean() }))
    .parse(await run("lifecycle-owner", { action: "tabs", browser: "fixture" }))
  assert.equal(
    lifecycleTabs.find((entry) => entry.targetId === temporaryWindow.tab)
      ?.claimed,
    true
  )
  await assert.rejects(
    run("lifecycle-other", {
      action: "select",
      browser: "fixture",
      tab: temporaryWindow.tab,
    }),
    /temporary browser resource/
  )
  const transferred = BrowserTargetSchema.parse(
    await run("lifecycle-other", {
      action: "select",
      browser: "fixture",
      tab: temporaryWindow.tab,
      takeover: true,
    })
  )
  assert.deepEqual(await service.releaseOwner("lifecycle-owner"), {
    released: 0,
    closed: 0,
  })
  assert.deepEqual(await service.releaseOwner("lifecycle-other"), {
    released: 1,
    closed: 1,
  })
  assert.equal(fixture.targets.has(transferred.tab), false)

  const persistent = BrowserTargetSchema.parse(
    await run("persistent-owner", {
      action: "open",
      browser: "fixture",
      lifetime: "persistent",
    })
  )
  assert.deepEqual(await service.releaseOwner("persistent-owner"), {
    released: 1,
    closed: 0,
  })
  assert.equal(
    fixture.targets.has(persistent.tab),
    true,
    "persistent targets survive owner cleanup"
  )
  await assert.rejects(
    run("isolated-owner", {
      action: "open",
      browser: "fixture",
      context: "isolated",
      lifetime: "persistent",
    }),
    /must use task lifetime/
  )
  const isolated = BrowserTargetSchema.parse(
    await run("isolated-owner", {
      action: "open",
      browser: "fixture",
      context: "isolated",
      disposition: "window",
    })
  )
  const isolatedCreate = fixture.calls
    .filter((call) => call.method === "Target.createTarget")
    .at(-1)
  z.string().parse(isolatedCreate?.params.browserContextId)
  assert.equal(isolatedCreate?.params.newWindow, true)
  assert.deepEqual(await service.releaseOwner("isolated-owner"), {
    released: 1,
    closed: 1,
  })
  assert.equal(fixture.targets.has(isolated.tab), false)
  assert.equal(fixture.calls.at(-1)?.method, "Target.disposeBrowserContext")

  // With no browser discovered the message says what to install.
  const empty = new BrowserService([])
  await assert.rejects(
    empty.execute(
      "task-z",
      BrowserCommandSchema.parse({ action: "connect", browser: "chrome" }),
      new AbortController().signal
    ),
    /Mako Browser extension/
  )
  empty.close()
  console.log(
    "Browser service: one connection for ten tasks; exact targets, serialized claims, stale leases, cancellation uncertainty, no retarget/replay, restart generations, binding authorization, real pointer/key input, bounded observations and events, navigation waits, dialogs, downloads, PDF, cookies, frames, waits, history, select options and malformed-frame tolerance verified"
  )
} finally {
  control.close()
  await attachedFixture.close()
  await fixture.close()
}

// Cookie writes invalidate a profile, not just their originating tab. Refuse
// contention before dispatch, including tabs whose acquisition is still pending.
const profileFixture = await browserFixture()
const profileService = new BrowserService([profileFixture.definition])
const profileRun = (owner: string, command: z.input<typeof BrowserCommandSchema>, signal = new AbortController().signal) =>
  profileService.execute(owner, BrowserCommandSchema.parse(command), signal)
try {
  await profileRun("a", { action: "connect", browser: "fixture" })
  const a = BrowserTargetSchema.parse(await profileRun("a", { action: "open", browser: "fixture" }))
  await profileRun("b", { action: "open", browser: "fixture" })
  const cookie = BrowserCommandSchema.parse({ action: "cookies", target: a, operation: "set", cookies: [{ name: "session", value: "fixture", url: "https://example.test" }] })
  await assert.rejects(profileRun("a", cookie), /Other tasks own tabs/)
  assert.equal(profileFixture.calls.filter(call => call.method === "Network.setCookies").length, 0)
  for (const method of ["Browser.close", "Browser.setDownloadBehavior", "Storage.setCookies", "Network.clearBrowserCookies", "Network.setCookies", "Target.sendMessageToTarget"])
    await assert.rejects(profileRun("a", { action: "cdp", target: a, method, params: {} }), /outside the tab lease|target lifecycle/)
  assert.ok(!profileFixture.calls.some(call => call.method === "Browser.close"))
  await assert.rejects(
    profileRun("a", { action: "cdp", target: a, method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } }),
    /belongs to managed input and live capture/
  )
  assert.equal(profileFixture.calls.filter(call => call.method === "Emulation.setFocusEmulationEnabled").length, 0,
    "Raw commands cannot disable focus owned by another capture/input consumer")
  await profileService.releaseOwner("b")
  const peer = BrowserTargetSchema.parse(await profileRun("a", { action: "open", browser: "fixture" }))
  const abort = new AbortController()
  profileFixture.holdNextCookieWrite()
  const pending = profileRun("a", cookie, abort.signal)
  const rejected = assert.rejects(pending, error => error instanceof BrowserFault && error.detail.outcome === "unknown")
  const deadline = Date.now() + 5000
  while (!profileFixture.calls.some(call => call.method === "Network.setCookies")) {
    assert.ok(Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  await assert.rejects(profileRun("b", { action: "open", browser: "fixture" }), /cookie operation is pending/)
  await assert.rejects(profileRun("a", { action: "observe", target: peer }), /cookie operation is pending/)
  abort.abort()
  await rejected
  profileFixture.completeCookieWrite()
  await assert.rejects(profileRun("a", { action: "press", target: peer, key: "Enter" }), /Observe/)
  const later = BrowserTargetSchema.parse(await profileRun("a", { action: "open", browser: "fixture" }))
  await assert.rejects(profileRun("a", { action: "press", target: later, key: "Enter" }), /Observe/)
  await profileRun("a", { action: "observe", target: peer })
  await profileRun("a", { action: "press", target: peer, key: "Enter" })
  await assert.rejects(profileRun("a", { action: "press", target: a, key: "Enter" }), /Observe/)
  assert.equal(profileFixture.calls.filter(call => call.method === "Network.setCookies").length, 1, "Unknown cookie write was never replayed")
  console.log("Browser-wide ownership: cross-task cookie refusal, raw browser administration refusal, pending profile lock and uncertainty across existing/new tabs passed")
} finally {
  await profileService.releaseOwner("a")
  await profileService.releaseOwner("b")
  profileService.close()
  await profileFixture.close()
}
