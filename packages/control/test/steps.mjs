import assert from "node:assert/strict"
import { computerHelpers } from "../dist/computer/index.js"

// A driver stand-in: one window whose elements change after a click, a
// window list with Finder-style helpers, and a refused action.
const calls = []
let phase = "home"
const screens = {
  home: [
    { element_token: "s0000000a:1", role: "AXButton", label: "Settings" },
    {
      element_token: "s0000000a:2",
      role: "AXStaticText",
      label: "Dashboard",
      value: "Dashboard",
    },
    { element_token: "s0000000a:3", role: "AXMenuItem", label: "About" },
  ],
  settings: [
    { element_token: "s0000000b:1", role: "AXButton", label: "Back" },
    { element_token: "s0000000b:2", role: "AXLink", label: "General" },
    { element_token: "s0000000b:3", role: "AXLink", label: "Git" },
  ],
}
const api = {
  get_window_state: async (args) => {
    calls.push(["get_window_state", args])
    const screen = screens[phase]
    return {
      elements: Array.isArray(screen) ? screen : screen(),
      window_id: args.window_id,
    }
  },
  click: async (args) => {
    calls.push(["click", args])
    phase = "settings"
    return {
      route: "accessibility",
      delivery: { mode: "background" },
      effect: "unverifiable",
      frame: { x: 1 },
    }
  },
  list_windows: async (args) => {
    calls.push(["list_windows", args])
    return {
      windows: [
        {
          window_id: 89,
          title: "",
          bounds: { x: 0, y: 0, width: 1352, height: 30 },
          is_on_screen: false,
        },
        // Listed first by the driver, as Conductor's is: untitled, off screen.
        {
          window_id: 7,
          title: "",
          bounds: { x: 0, y: 378, width: 500, height: 500 },
          is_on_screen: false,
        },
        {
          window_id: 5,
          title: "Downloads",
          bounds: { x: 0, y: 0, width: 900, height: 600 },
          is_on_screen: true,
        },
      ],
    }
  },
  refuse: async () => {
    throw new Error("driver refused: window unresolved")
  },
  set_value: async (args) => {
    calls.push(["set_value", args])
    fieldValue = args.value
    return { effect: "unverifiable", route: "accessibility" }
  },
  page_routes: async () => ({
    42: { browser: "app:dev.mako.fixture", endpoint: "ws://127.0.0.1:1/x" },
  }),
}
let fieldValue = ""
screens.form = () => [
  {
    element_token: "s0000000c:1",
    role: "AXTextField",
    label: "Proof",
    value: fieldValue,
  },
  { element_token: "s0000000c:2", role: "AXButton", label: "Verify proof" },
]
const state = {}
const h = computerHelpers(api, state)

// view needs a target, remembers it, drops the menu bar, caches the lines.
await assert.rejects(() => h.view(), /No window is selected/)
const home = await h.view({ pid: 42, window_id: 7 })
assert.deepEqual(home, [
  's0000000a:1 Button "Settings"',
  's0000000a:2 StaticText "Dashboard"',
])
assert.deepEqual(state.target, { pid: 42, window_id: 7 })
assert.deepEqual(state.last, home)
assert.deepEqual(state.lastTarget, { pid: 42, window_id: 7 })
assert.equal(h.token(home[0]), "s0000000a:1")
assert.throws(() => h.token('Button "Settings"'), /no element token/)
assert.deepEqual(calls.at(-1)[1], {
  pid: 42,
  window_id: 7,
  include_screenshot: false,
  max_elements: 400,
})
assert.deepEqual(await h.view(undefined, { query: "dash", max: 50 }), [
  's0000000a:2 StaticText "Dashboard"',
])
assert.equal(calls.at(-1)[1].max_elements, 50)
assert.equal(calls.at(-1)[1].query, "dash")
await h.view()

// act: the action, then only what changed, with the delivery facts kept.
const t0 = Date.now()
const step = await h.act(
  "click",
  { element_token: "s0000000a:1" },
  { settle: 20 }
)
assert.ok(Date.now() - t0 < 500)
// A step whose screen has not moved yet is re-read until it does or the wait ends.
let noopReads = 0
const quietApi = {
  ...api,
  get_window_state: async (args) => {
    noopReads++
    return api.get_window_state(args)
  },
  noop: async () => ({ effect: "ok" }),
}
const quiet = computerHelpers(quietApi, { target: { pid: 1, window_id: 2 } })
const t1 = Date.now()
const still = await quiet.act("noop", {}, { settle: 10, wait: 120 })
assert.ok(Date.now() - t1 >= 120 && Date.now() - t1 < 1000)
assert.ok(noopReads >= 2, `re-read while nothing changed (${noopReads} reads)`)
assert.deepEqual([still.added, still.removed], [[], []])
assert.equal(still.postcondition, null)
assert.equal(step.action, "click")
assert.deepEqual(step.result, {
  route: "accessibility",
  delivery: { mode: "background" },
  effect: "unverifiable",
})
assert.deepEqual(step.receipt, {
  action: "click",
  target: { pid: 42, window_id: 7 },
  route: "accessibility",
  delivery: "background",
  outcome: "unverifiable",
  verification: { kind: "observation", status: "changed" },
})
assert.deepEqual(step.added, [
  's0000000b:1 Button "Back"',
  's0000000b:2 Link "General"',
  's0000000b:3 Link "Git"',
])
assert.deepEqual(step.removed, ['Button "Settings"', 'StaticText "Dashboard"'])
assert.equal(step.unchanged, 0)
assert.deepEqual(step.target, { pid: 42, window_id: 7 })
assert.deepEqual(step.opened, [])
assert.deepEqual(step.closed, [])
assert.deepEqual(calls.filter((c) => c[0] === "click")[0][1], {
  element_token: "s0000000a:1",
  pid: 42,
  window_id: 7,
})
await assert.rejects(
  () => h.act("click", { pid: 99 }),
  /names pid 99, but the selected window belongs to pid 42/
)
await assert.rejects(
  () => h.act("click", { window_id: 99 }),
  /names window 99, but the selected window is 7/
)
await assert.rejects(() => h.act("nope", {}), /Unknown computer action "nope"/)
await assert.rejects(() => h.act("refuse", {}, { settle: 0 }), /driver refused/)

// An action reports a same-application document window that appeared while
// the target itself stayed unchanged.
{
  let opened = false
  const windowSteps = computerHelpers(
    {
      get_window_state: async () => ({
        elements: [
          { element_token: "s00000020:1", role: "AXButton", label: "Open" },
        ],
      }),
      list_windows: async () => ({
        windows: [
          { window_id: 7, title: "Main", is_on_screen: true },
          ...(opened
            ? [{ window_id: 8, title: "Settings", is_on_screen: true }]
            : []),
        ],
      }),
      click: async () => {
        opened = true
        return { route: "accessibility" }
      },
    },
    { target: { pid: 42, window_id: 7 } }
  )
  await windowSteps.view()
  const result = await windowSteps.act(
    "click",
    { element_token: "s00000020:1" },
    { settle: 0, wait: 0 }
  )
  assert.deepEqual(
    result.opened.map((window) => window.window_id),
    [8]
  )
}

// A token-addressed act never reads before it dispatches, however old the
// cached view: the driver honours tokens from the newest snapshot only, so a
// read first would make the model's token stale. The before is the cached
// view from the earlier program.
{
  const reads = []
  let snapshot = "s00000010"
  const tokenApi = {
    get_window_state: async () => {
      reads.push(snapshot)
      return {
        elements: [
          {
            element_token: `${snapshot}:1`,
            role: "AXButton",
            label: snapshot === "s00000010" ? "Open" : "Close",
          },
        ],
      }
    },
    click: async (args) => {
      if (!args.element_token.startsWith(snapshot))
        throw new Error(
          "element_token is stale; call get_window_state again to refresh"
        )
      snapshot = "s00000011"
      return { effect: "unverifiable" }
    },
    fail: async () => {
      throw new Error("driver refused: nothing was posted")
    },
  }
  const aged = { target: { pid: 1, window_id: 2 } }
  const tokenSteps = computerHelpers(tokenApi, aged)
  const seen = await tokenSteps.view()
  aged.lastAt = Date.now() - 60_000 // an earlier turn
  const acted = await tokenSteps.act(
    "click",
    { element_token: seen[0].split(" ")[0] },
    {
      settle: 5,
      wait: 50,
      postcondition: (lines) => lines.some((line) => /"Close"/.test(line)),
    }
  )
  assert.equal(acted.postcondition, true)
  assert.equal(acted.receipt.outcome, "confirmed")
  assert.deepEqual(acted.receipt.verification, {
    kind: "read-back",
    status: "confirmed",
  })
  assert.deepEqual(
    reads,
    ["s00000010", "s00000011"],
    "one read for the view, one after the click, none between"
  )
  assert.deepEqual(acted.added, ['s00000011:1 Button "Close"'])
  assert.deepEqual(acted.removed, ['Button "Open"'])
  // A failed action returns as soon as its rejection is known; the wait is
  // not spent re-reading a window the action never touched.
  const t2 = Date.now()
  await assert.rejects(
    () => tokenSteps.act("fail", {}, { settle: 5, wait: 2000 }),
    /nothing was posted/
  )
  assert.ok(
    Date.now() - t2 < 500,
    `a refused action does not wait out the delta (${Date.now() - t2} ms)`
  )
}

// until polls to a condition or reports the time it gave up at.
const found = await h.until((lines) => lines.some((l) => /Git/.test(l)), {
  every: 5,
})
assert.equal(found.satisfied, true)
const gaveUp = await h.until((lines) => lines.some((l) => /Nowhere/.test(l)), {
  timeout: 30,
  every: 5,
})
assert.equal(gaveUp.satisfied, false)
assert.ok(gaveUp.ms >= 30)
assert.equal(gaveUp.view.length, 3)

// expect stops the program with the screen in the message.
await h.expect((lines) => lines.length === 3)
await h.expect(true)
await assert.rejects(
  () => h.expect(false, "Expected a computed condition"),
  /Expected a computed condition\. The window shows:/
)
await assert.rejects(
  () => h.expect((lines) => lines.length === 99, "Expected the home screen"),
  /Expected the home screen\. The window shows:\ns0000000b:1 Button "Back"/
)

// windows: helper strips are gone, kinds are named, other fields kept, and
// the on-screen document comes first however the driver listed them.
const windows = await h.windows(1374)
assert.deepEqual(
  windows.map((w) => [w.window_id, w.kind]),
  [
    [5, "document"],
    [7, "unknown"],
  ]
)
assert.equal(windows[0].is_on_screen, true)
assert.equal(calls.at(-1)[1].pid, 1374)

// fill: the value write, then the same control read back by role and label
// (its token changed with the snapshot) until it shows the text.
phase = "form"
await h.view({ pid: 42, window_id: 7 })
const filled = await h.fill("s0000000c:1", "hello there", { wait: 500 })
assert.equal(filled.confirmed, true)
assert.equal(filled.route, "set_value")
assert.equal(filled.receipt.route, "accessibility")
assert.equal(filled.receipt.outcome, "confirmed")
assert.match(filled.line, /TextField "Proof" ="hello there"$/)
assert.deepEqual(calls.filter((c) => c[0] === "set_value").at(-1)[1], {
  element_token: "s0000000c:1",
  value: "hello there",
  pid: 42,
  window_id: 7,
})
assert.deepEqual(filled.view, state.last)
// A control that never shows the text is reported unconfirmed, not assumed.
const stubbornApi = {
  ...api,
  set_value: async () => ({ effect: "unverifiable" }),
}
const stubborn = computerHelpers(stubbornApi, {
  target: { pid: 42, window_id: 7 },
})
fieldValue = "old"
await stubborn.view()
const unconfirmed = await stubborn.fill("s0000000c:1", "new text", { wait: 60 })
assert.equal(unconfirmed.confirmed, false)
assert.match(unconfirmed.line, /="old"/)

// submit: confirm first, press when the control has no confirm.
const clicks = []
const confirmApi = {
  ...api,
  click: async (args) => {
    clicks.push(args)
    if (args.action === "confirm") throw new Error("AXConfirm unsupported")
    return { route: "accessibility" }
  },
}
const submitted = await computerHelpers(confirmApi, {
  target: { pid: 42, window_id: 7 },
}).submit("s0000000c:1")
assert.equal(submitted.route, "press")
assert.equal(submitted.receipt.route, "accessibility")
assert.deepEqual(
  clicks.map((c) => c.action),
  ["confirm", "press"]
)
assert.ok(clicks.every((call) => call.pid === 42 && call.window_id === 7))
let uncertainCalls = 0
const uncertain = computerHelpers(
  {
    click: async () => {
      uncertainCalls++
      throw new Error("timed out after dispatch; outcome unknown")
    },
  },
  { target: { pid: 42, window_id: 7 } }
)
await assert.rejects(() => uncertain.submit("s0000000c:1"), /outcome unknown/)
assert.equal(uncertainCalls, 1, "an unknown confirm outcome is never repeated")

// routes: verdicts before a round trip, from the window list and the page routes.
const verdicts = await h.routes({ pid: 42, window_id: 7 })
assert.deepEqual(verdicts.target, { pid: 42, window_id: 7 })
const keyboardRoute = verdicts.routes.find(
  (route) => route.route === "pid-keyboard"
)
assert.equal(keyboardRoute.status, "unavailable")
assert.match(keyboardRoute.reason, /2 document windows/)
assert.equal(
  verdicts.routes.find((route) => route.route === "page").browser,
  "app:dev.mako.fixture"
)
assert.equal((await h.route("page")).capability.route, "page")
assert.equal((await h.route("text")).capability.route, "accessibility")
const single = computerHelpers(
  {
    ...api,
    list_windows: async () => ({
      windows: [{ window_id: 7, title: "One", is_on_screen: false }],
    }),
  },
  {}
)
const offScreen = await single.routes({ pid: 9, window_id: 7 })
assert.equal(
  offScreen.routes.find((route) => route.route === "pid-keyboard").status,
  "unavailable"
)
assert.equal(
  offScreen.routes.find((route) => route.route === "window-pointer").status,
  "unavailable"
)
assert.equal(
  offScreen.routes.find((route) => route.route === "page").status,
  "unavailable"
)
console.log("steps ok")
