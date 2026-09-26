import assert from "node:assert/strict"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import { createControlSession } from "../packages/control-runtime/dist/control-session.js"
import { controlClient, controlInput, ControlLocator, ControlObservation, TabHandle, WindowHandle } from "@mako/control/control"
import { RecordingHandle } from "../packages/control/src/control/recording.ts"

const target = {
  kind: "page",
  browser: "fixture",
  tab: "one",
  generation: "gen",
  lease: "lease",
}
let calls = 0,
  writes = 0,
  malformedReply = false
const browserCall = async (command) => {
  calls++
  if (command.action === "type") {
    writes++
    if (malformedReply) return z.string().parse(17) // Response validation AFTER the mutation.
    return { status: "typed" }
  }
  if (command.action === "observe")
    return {
      observation: "one",
      target,
      omitted: 0,
      nextOffset: null,
      truncatedTextFields: 0,
      lines: ['abc123:1 textbox "Name"'],
      coverage: { complete: true, omitted: 0, textComplete: true },
      nodes: [{ ref: "abc123:1", role: "textbox", name: "Name", depth: 0 }],
    }
  return {}
}
const server = controlSessionProbe(undefined, "input-errors", undefined, {
  browserCall,
})
const client = server


const exec = (source) =>
  client.request({ method: "exec", arguments: { source } })
try {
  for (const source of [
    `return await control.tab(${JSON.stringify(target)}).observe({max:'ten'})`,
    `return control.tab(${JSON.stringify(target)}).locator({role:'button',name:/Save/})`,
    `return await control.tab(${JSON.stringify(target)}).click('abc123:1',{buton:'right'})`,
    `return await control.tab(${JSON.stringify(target)}).record({fps:'sixty'})`,
    `return await control.tab(${JSON.stringify(target)}).screenshot({scale:2})`,
    `return await control.tab(${JSON.stringify(target)}).observe({text:'Generate'})`,
    `return control.tab(${JSON.stringify(target)}).locator({text:'Generate'})`,
    `return control.tab(${JSON.stringify(target)}).locator({selector:'button.primary'})`,
    `return (await control.tab(${JSON.stringify(target)}).observe()).get('Generate')`,
    `return (await control.tab(${JSON.stringify(target)}).observe()).select({query:'gen'})`,
  ]) {
    const before = calls
    const result = await exec(source)
    if (source.includes("observe({text"))
      assert.match(result.structuredContent.message, /Unknown fields: "text".*query \(text search/, source)
    else if (/text:|selector:|get\(/.test(source))
      assert.match(result.structuredContent.message, /to search by text use observe\(\{query\}\) or select\(\{text\}\); CSS selectors are not supported/, source)
    if (/select\(/.test(source))
      assert.match(result.structuredContent.message, /optional keys: text \(substring/, source)
    assert.equal(result.isError, true)
    assert.equal(
      result.structuredContent.code,
      "invalid-request",
      JSON.stringify(result)
    )
    assert.equal(result.structuredContent.outcome, "not-dispatched")
    assert.equal(calls - before, source.includes("observe())") ? 1 : 0, "Invalid input must not reach the backend")
    assert.ok(result.structuredContent.message.length < 1400)
    assert.ok(
      !result.structuredContent.message.includes('"code": "invalid_type"')
    )
  }
  // Correct one operation after a failed program; retained state prevents whole-program replay.
  const partiallyRun = await exec(
    `state.tab=control.tab(${JSON.stringify(target)});state.steps=0;await state.tab.observe();await state.tab.setValue('abc123:1','once');state.steps++;await state.tab.observe({max:'ten'})`
  )
  assert.equal(partiallyRun.structuredContent.outcome, "not-dispatched")
  assert.equal(writes, 1)
  const state = await exec("return state.steps")
  assert.equal(JSON.parse(state.content[0].text), 1)
  const corrected = await exec("return await state.tab.observe({max:10})")
  assert.ok(!corrected.isError, JSON.stringify(corrected))
  assert.equal(writes, 1, "Correcting a read never repeats earlier input")

  malformedReply = true
  const postDispatch = await exec(
    "await state.tab.setValue('abc123:1','uncertain')"
  )
  assert.equal(
    postDispatch.structuredContent.outcome,
    "unknown",
    JSON.stringify(postDispatch)
  )
  const guarded = await exec(
    "await state.tab.setValue('abc123:1','must not run')"
  )
  assert.equal(guarded.structuredContent.code, "observation-required")
  assert.equal(
    writes,
    2,
    "A backend ZodError cannot be relabeled as preflight validation"
  )

  const native = createControlSession()
  try {
    const members = (value) => {
      const names = new Set()
      for (let proto = value; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
        for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
      return names
    }
    const known = new Set([
      ...Object.keys(controlClient(async () => ({}))),
      ...members(TabHandle.prototype),
      ...members(WindowHandle.prototype),
      ...members(ControlLocator.prototype),
      ...members(ControlObservation.prototype),
      ...members(RecordingHandle.prototype),
      "find", "stringify",
    ])
    const AsyncFunction = (async () => {}).constructor
    for (const syntax of ["script", "repl"]) {
      const { examples } = await native.call({ action: "help", topic: "examples", syntax }, new AbortController().signal)
      for (const [name, source] of Object.entries(examples)) {
        if (name === "note") continue
        const program = source.replaceAll("TARGET_JSON", "{}")
        assert.doesNotThrow(() => new AsyncFunction("control", "state", "emitImage", program), `${syntax} example ${name} compiles`)
        for (const [, method] of program.matchAll(/\.(\w+)\(/g))
          assert.ok(known.has(method), `${syntax} example ${name} calls .${method}(), which the SDK does not define`)
      }
    }
    await assert.rejects(
      native.call(
        {
          action: "recording",
          target: { kind: "window", pid: 42, window_id: 7 },
          operation: "stop",
        },
        new AbortController().signal
      ),
      { code: "invalid-request", outcome: "not-dispatched" }
    )
  } finally {
    await native.close()
  }

  const local = controlClient(async () => {
    throw new Error("Unexpected dispatch")
  }).window({ pid: 42, window_id: 7 })
  assert.throws(() => local.click("ref", { buton: "right" }), {
    code: "invalid-request",
    outcome: "not-dispatched",
  })
  const reads = []
  const labelled = controlClient(async (method, args) => {
    if (method !== "observe") throw new Error("Unexpected dispatch")
    reads.push(args)
    return {
      observation: "two",
      target,
      omitted: 0,
      nextOffset: null,
      truncatedTextFields: 0,
      lines: [],
      coverage: { complete: true, omitted: 0, textComplete: true },
      nodes: args.match ? [] : [{ ref: "abc123:2", role: "button", name: "Create image", visibleText: "Generate", depth: 0 }],
    }
  }).tab(target)
  const namesIt = (error) =>
    error.code === "target-not-found" &&
    error.outcome === "not-dispatched" &&
    error.message.includes('"Generate" is the visible text of button "Create image" (abc123:2)') &&
    error.message.includes('locator({role:"button",name:"Create image"})')
  await assert.rejects(labelled.locator({ role: "button", name: "Generate" }).click(), namesIt)
  assert.deepEqual(reads.map((read) => [Boolean(read.match), read.query]), [[true, undefined], [false, "Generate"]], "one read-only follow-up search; exact matching is unchanged")
  const seen = await labelled.observe()
  assert.throws(() => seen.get({ role: "button", name: "Generate" }), namesIt)
  assert.throws(() => seen.get({ role: "button", name: "Save" }), (error) => error.code === "target-not-found" && error.message.includes("Candidates: []"))
  for (const bad of [
    "payload",
    { max: "SECRET_PAYLOAD_DO_NOT_ECHO" },
    { ["x".repeat(10000)]: "SECRET_PAYLOAD_DO_NOT_ECHO" },
  ]) {
    assert.throws(
      () =>
        controlInput(
          z.object({ max: z.number() }).strict().safeParse(bad),
          "options",
          "Use {max:10}."
        ),
      (error) =>
        error.message.length < 1400 &&
        !error.message.includes("SECRET_PAYLOAD_DO_NOT_ECHO")
    )
  }
  console.log(
    "Control inputs: bounded corrections, no typo clicks, engine fault fidelity, retained partial-program state, and post-dispatch uncertainty passed"
  )
} finally {

  await server.close()
}
