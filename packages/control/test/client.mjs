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
