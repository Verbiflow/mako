import assert from "node:assert/strict"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import { createControlSession } from "../packages/control-runtime/dist/control-session.js"
import { controlClient, controlInput } from "@mako/control/control"

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
  ]) {
    const before = calls
    const result = await exec(source)
    assert.equal(result.isError, true)
    assert.equal(
      result.structuredContent.code,
      "invalid-request",
      JSON.stringify(result)
    )
    assert.equal(result.structuredContent.outcome, "not-dispatched")
    assert.equal(calls, before, "Invalid input must not reach the backend")
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
