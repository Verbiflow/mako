import { recordingReceipt } from "../dist/control/recording.js"
import assert from "node:assert/strict"
import { controlClient, ControlObservation } from "../dist/control/index.js"
const target = { kind: "window", pid: 42, window_id: 7 }
const field = (name, value, ref = "s00000001:1") => ({
  role: "TextField",
  name,
  value,
  ref,
  depth: 0,
})
const observation = (
  nodes,
  coverage = { complete: true, omitted: 0, textComplete: true }
) => ({
  target,
  observation: "s00000001",
  lineage: "window-instance-1",
  nodes,
  lines: nodes.map(
    (n) =>
      `${n.ref} ${n.role} ${JSON.stringify(n.name)} =${JSON.stringify(n.value)}`
  ),
  coverage,
})
let current = observation([field("Name", "")])
let mutations = 0
const client = controlClient(async (action) => {
  if (action === "observe") return current
  if (action === "dispatch") {
    mutations++
    return {
      status: "dispatched",
      actionId: "one",
      route: "accessibility",
      delivery: "background",
      verification: "not-requested",
      guard: { status: "settled" },
    }
  }
  throw new Error(action)
})
const window = client.window({ pid: 42, window_id: 7 })
assert.equal(client.act, undefined)
assert.equal(client.observe, undefined)
assert.equal(client.advanced, undefined)
assert.deepEqual(window.toJSON(), target)
const empty = await window.expect(
  { role: "TextField", name: "Name", value: "" },
  { timeoutMs: 0 }
)
assert.equal(empty.evidence.value, "")
current = observation([
  field("Name", "wrong"),
  field("Other", "expected", "s00000001:2"),
])
await assert.rejects(
  window.expect(
    { role: "TextField", name: "Name", value: "expected" },
    { timeoutMs: 0 }
  ),
  /not established/
)
current = observation([
  field("Name", "expected"),
  field("Name", "expected", "s00000001:2"),
])
await assert.rejects(
  window.expect(
    { role: "TextField", name: "Name", value: "expected" },
    { timeoutMs: 0 }
  ),
  /ambiguous/
)
const long = "x".repeat(1200)
current = observation([field("Name", long + "wrong")])
await assert.rejects(
  window.expect(
    { role: "TextField", name: "Name", value: long },
    { timeoutMs: 0 }
  ),
  /not established/
)
current = observation([field("Name", long)])
assert.equal(
  (
    await window.expect(
      { role: "TextField", name: "Name", value: long },
      { timeoutMs: 0 }
    )
  ).evidence.value,
  long
)
current = observation([field("Name", "truncated…")], {
  complete: true,
  omitted: 0,
  textComplete: false,
})
await assert.rejects(
  window.expect(
    { role: "TextField", name: "Name", value: "truncated…" },
    { timeoutMs: 0 }
  ),
  /not established/
)
current = observation([], {
  complete: false,
  omitted: null,
  textComplete: true,
})
await assert.rejects(
  window.expect(
    { role: "Button", name: "Save", absent: true },
    { timeoutMs: 0 }
  ),
  /not established/
)
current = observation([])
assert.equal(
  (
    await window.expect(
      { role: "Button", name: "Save", absent: true },
      { timeoutMs: 0 }
    )
  ).status,
  "matched"
)
assert.equal(mutations, 0, "assertions never replay input")
const first = new ControlObservation(observation([field("Name", "same")]))
const second = new ControlObservation({
  ...observation([field("Name", "same", "s00000002:1")]),
  observation: "s00000002",
})
assert.deepEqual(
  second.diff(first).added,
  [],
  "snapshot churn does not bloat diffs"
)
assert.deepEqual(second.diff(first).removed, [])
assert.equal(
  JSON.parse(JSON.stringify(first)).nodes,
  undefined,
  "structured nodes stay local by default"
)
assert.throws(
  () =>
    new ControlObservation(
      observation([field("Name", "a"), field("Name", "b")])
    ).get({ role: "TextField", name: "Name" }),
  /found 2/
)
console.log(
  "Control client: exact assertions, ambiguity, incomplete reads, compact output and snapshot-independent diffs passed"
)

const selected = first.select({ roles: ["TextField"] })
assert.equal(selected.nodes.length, 1)
assert.equal(JSON.parse(JSON.stringify(selected)).nodes, undefined)

const scopedView = new ControlObservation(
  observation([
    { depth: 0, role: "form", name: "Shipping", ref: "s1:0" },
    { ...field("Email", "shipping", "s1:1"), depth: 1 },
    { depth: 0, role: "form", name: "Billing", ref: "s1:2" },
    { ...field("Email", "billing", "s1:3"), depth: 1 },
  ])
)
assert.throws(
  () => scopedView.get({ role: "TextField", name: "Email" }),
  /found 2/
)
assert.equal(
  scopedView.get({
    role: "TextField",
    name: "Email",
    within: [{ role: "form", name: "Billing" }],
  }).value,
  "billing"
)
assert.throws(
  () =>
    scopedView.get({
      role: "TextField",
      name: "Email",
      within: [{ role: "form", name: "missing" }],
    }),
  /found 0/
)

// A lossy native display value can never prove exact equality.
current = observation([{ ...field("Name", "東京 🐟"), valueExact: false }])
await assert.rejects(
  window.expect(
    { role: "TextField", name: "Name", value: "東京 🐟" },
    { timeoutMs: 0 }
  ),
  /Exact value unavailable/
)
for (const value of ["", "  ", "  東京 🐟  ", "00123", "\tline\n"]) {
  current = observation([{ ...field("Name", value), valueExact: true }])
  assert.equal(
    (
      await window.expect(
        { role: "TextField", name: "Name", value },
        { timeoutMs: 0 }
      )
    ).evidence.value,
    value
  )
  await assert.rejects(
    window.expect(
      { role: "TextField", name: "Name", value: value + " " },
      { timeoutMs: 0 }
    ),
    /not established/
  )
}

// Locators retain semantic intent, resolve freshly, and never retry mutations.
const calls = []
let locatorRead = observation([field("Name", "", "s1:1")])
const locatorClient = controlClient(async (action, args) => {
  calls.push({ action, args })
  if (action === "observe") return locatorRead
  if (action === "dispatch")
    return {
      status: "dispatched",
      actionId: "locator",
      route: "accessibility",
      delivery: "background",
      verification: "not-requested",
      guard: { status: "settled" },
    }
  throw new Error(action)
})
const nameLocator = locatorClient
  .window({ pid: 42, window_id: 7 })
  .locator({ role: "form", name: "Billing" })
  .locator({ role: "TextField", name: "Name" })
await nameLocator.setValue("one")
assert.deepEqual(calls[0].args.within, [{ role: "form", name: "Billing" }])
assert.equal(calls[1].args.operation.ref, "s1:1")
locatorRead = {
  ...observation([field("Name", "one", "s2:1")]),
  observation: "s2",
}
await nameLocator.setValue("two")
assert.equal(calls[3].args.operation.ref, "s2:1")
locatorRead = observation([field("Name", "a"), field("Name", "b", "s1:2")])
await assert.rejects(nameLocator.click(), /found 2/)
assert.equal(calls.filter((c) => c.action === "dispatch").length, 2)
locatorRead = observation([field("Name", "a")], {
  complete: false,
  omitted: 4,
  textComplete: true,
})
await assert.rejects(nameLocator.click(), /coverage is incomplete/)
assert.equal(calls.filter((c) => c.action === "dispatch").length, 2)
locatorRead = observation([{ role: "TextField", name: "Name", depth: 0 }])
await assert.rejects(nameLocator.click(), /no actionable reference/)
console.log(
  "Fresh scoped locators: unique dispatch, renewed refs, ambiguity and partial-coverage refusal passed"
)

await nameLocator.read({ max: 20 })
assert.deepEqual(
  calls.at(-1).args.within,
  [
    { role: "form", name: "Billing" },
    { role: "TextField", name: "Name" },
  ],
  "Explicit locator reads return its subtree"
)
assert.equal(calls.at(-1).args.match, undefined)

// Different forms, documents, incomplete reads and reordered rows are not deltas.
const compare = (changes) =>
  new ControlObservation({ ...first.data, ...changes }).diff(first)
assert.equal(
  compare({ scope: { match: { role: "TextField", name: "Other" } } }).reason,
  "scope-changed"
)
assert.equal(
  compare({ lineage: "window-instance-2" }).reason,
  "lineage-changed"
)
assert.equal(compare({ lineage: undefined }).reason, "lineage-unavailable")
assert.equal(
  compare({ coverage: { complete: false, omitted: 1, textComplete: true } })
    .reason,
  "incomplete-observation"
)
assert.equal(compare({ scope: { within: [] } }).kind, "delta")
const ordered = new ControlObservation(
  observation([field("A", "1"), field("B", "2", "s1:2")])
)
assert.equal(
  new ControlObservation({
    ...ordered.data,
    nodes: [...ordered.nodes].reverse(),
  }).diff(ordered).reason,
  "order-changed"
)
const longBefore = new ControlObservation(
  observation([field("Name", "x".repeat(100) + "before")])
)
const longAfter = new ControlObservation(
  observation([field("Name", "x".repeat(100) + "after", "s2:1")])
)
assert.match(longAfter.diff(longBefore).added[0], /after/)
assert.doesNotMatch(longAfter.diff(longBefore).removed[0], /s00000001:1/)
const many = new ControlObservation(
  observation(
    Array.from({ length: 121 }, (_, i) => field(`Row ${i}`, "new", `s2:${i}`))
  )
)
assert.equal(many.diff(first).reason, "change-budget-exceeded")

const recordingTarget = { kind: "window", pid: 42, window_id: 7 }
let receipt = {
  id: "record-one",
  target: recordingTarget,
  status: "recording",
  directory: "/tmp/record-one",
  startedAt: 1,
  durationMs: 0,
  frames: 0,
  droppedFrames: 0,
}
let recordingCalls = 0
const recordingWindow = controlClient(async () => {
  recordingCalls++
  return receipt
}).window({ pid: 42, window_id: 7 })
const recording = await recordingWindow.record()
assert.equal((await recording.status()).id, "record-one")
receipt = { ...receipt, id: "record-two" }
await assert.rejects(recording.stop(), /does not belong/)
assert.equal(recordingCalls, 3, "mismatched receipts never trigger a retry")
receipt = { ...receipt, target: { ...recordingTarget, window_id: 8 } }
await assert.rejects(recordingWindow.record(), /does not belong/)
await assert.rejects(recordingWindow.record({ maxDurationMs: 0 }))

// Recording identity remains strict in browser-importable code.
const pageRecordingTarget = {
  kind: "page",
  browser: "chrome",
  tab: "1",
  generation: "g1",
  lease: "lease-1",
}
const pageRecording = { ...receipt, target: pageRecordingTarget }
assert.equal(
  recordingReceipt(pageRecording, {
    lease: "lease-1",
    generation: "g1",
    tab: "1",
    browser: "chrome",
    kind: "page",
  }),
  pageRecording
)
for (const field of ["browser", "tab", "generation", "lease"])
  assert.throws(
    () =>
      recordingReceipt(
        {
          ...pageRecording,
          target: { ...pageRecordingTarget, [field]: "different" },
        },
        pageRecordingTarget
      ),
    /does not belong/
  )
assert.throws(
  () => recordingReceipt(pageRecording, recordingTarget),
  /does not belong/
)
assert.throws(
  () =>
    recordingReceipt(
      { ...receipt, target: { ...recordingTarget, pid: 43 } },
      recordingTarget
    ),
  /does not belong/
)

// Restoring the foreground must not erase evidence that the task interrupted it.
const focusChange = {
  previous_pid: 7,
  current_pid: 7,
  restoration_attempted: true,
  input_activity_observed: false,
}
const interruptedClient = controlClient(async () => ({
  status: "dispatched",
  actionId: "interrupted",
  route: "accessibility",
  delivery: "background",
  verification: "not-requested",
  guard: { status: "settled" },
  focus_change: focusChange,
}))
const interrupted = await interruptedClient
  .window({ pid: 42, window_id: 7 })
  .click("s00000001:1")
assert.deepEqual(
  interrupted.focus_change,
  focusChange,
  "Restored focus interruption survives the public client"
)
assert.equal(interrupted.verification, "not-requested")

// Connection is an explicit public operation; discovery and open do not hide it.
const connectionCalls = []
const connectionClient = controlClient(async (action, request) => {
  connectionCalls.push({ action, request })
  return { status: "connected", generation: "fixture-generation" }
})
assert.deepEqual(await connectionClient.connectBrowser("mako-dev-fixture"), {
  status: "connected",
  generation: "fixture-generation",
})
assert.deepEqual(connectionCalls, [
  {
    action: "connect",
    request: { browser: "mako-dev-fixture" },
  },
])

// A failed navigation must not be hidden inside a successful tab handle.
const pageTarget = {
  kind: "page",
  browser: "scratch",
  tab: "tab",
  generation: "generation",
  lease: "lease",
}
const openFailure = controlClient(async () => ({
  ...pageTarget,
  navigation: { fault: { message: "Navigation interrupted" } },
}))
await assert.rejects(
  openFailure.openTab({ url: "https://example.test" }),
  (error) => {
    assert.equal(error.name, "TabNavigationError")
    assert.deepEqual(error.target, pageTarget)
    assert.match(error.message, /do not repeat openTab/)
    return true
  }
)
const scoped = new ControlObservation(
  observation([field("Name", "A"), field("Other", "B")])
)
assert.equal(
  scoped.select({ role: "TextField", name: "Name", includeAncestors: false })
    .nodes.length,
  1
)
const screenshotCalls = []
const pageClient = controlClient(async (action, args) => {
  screenshotCalls.push({ action, args })
  if (action === "observe")
    return { ...observation([field("Save", "", "p1")]), target: pageTarget }
  if (action === "capture") return { data: "image" }
  throw new Error(action)
})
await pageClient
  .tab(pageTarget)
  .locator({ role: "TextField", name: "Save" })
  .screenshot({ maxSide: 2048 })
assert.equal(screenshotCalls[1].args.options.ref, "p1")
assert.equal(screenshotCalls[1].args.options.maxSide, 2048)
assert.equal(screenshotCalls.length, 2)

// Ref clicks used to ignore a misspelled options key and perform a left click.
{
  const before = mutations
  assert.throws(() => window.click("s00000001:1", { buton: "right" }), {
    code: "invalid-request",
    outcome: "not-dispatched",
  })
  assert.equal(mutations, before)
  const view = new ControlObservation(
    observation([field("Name", "one"), field("Name", "two", "s00000001:2")])
  )
  assert.throws(() => view.get({ role: "TextField", name: "Name" }), {
    code: "target-ambiguous",
    outcome: "not-dispatched",
  })
  assert.throws(() => view.get({ role: "TextField", name: "Missing" }), {
    code: "target-not-found",
    outcome: "not-dispatched",
  })
  assert.throws(() => view.select({ name: /Name/ }), {
    code: "invalid-request",
    outcome: "not-dispatched",
  })
  assert.throws(
    () =>
      window.locator({
        role: "TextField",
        name: "Name",
        within: [{ role: "Group", text: "Profile" }],
      }),
    { code: "invalid-request", outcome: "not-dispatched" }
  )
  console.log(
    "Control client: typo clicks, ambiguity, missing targets and selector corrections carry pre-dispatch faults"
  )
}
