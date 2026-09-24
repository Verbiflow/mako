import assert from "node:assert/strict"
import type { z } from "zod"
import { BrowserConnection } from "../packages/control-runtime/src/browser-connection.js"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { BrowserCommandSchema, BrowserFault, BrowserTargetSchema, type BrowserTarget } from "../packages/control-runtime/src/contracts/browser-control.js"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const service = new BrowserService([fixture.definition])
const run = (input: z.input<typeof BrowserCommandSchema>, signal = new AbortController().signal) =>
  service.execute("modal-test", BrowserCommandSchema.parse(input), signal)
const settled = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: Error) => ({ ok: false as const, error }),
)
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1500)
    })])
  } finally { clearTimeout(timer) }
}
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 1500
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const open = async () => BrowserTargetSchema.parse(await run({ action: "open", browser: "fixture" }))
const click = (target: BrowserTarget, signal?: AbortSignal) => run({ action: "click", target, at: { x: 40, y: 20 } }, signal)
const session = (target: BrowserTarget) => {
  const value = fixture.sessionFor(target.tab)
  assert.ok(value)
  return value
}
const dialog = (target: BrowserTarget) => fixture.emit(session(target), "Page.javascriptDialogOpening", {
  type: "confirm", message: "Continue?", url: "https://example.test",
})
const inputs = (target: BrowserTarget) => fixture.calls.filter((call) =>
  call.sessionId === session(target) && ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"].includes(call.method))
const focusChanges = (target: BrowserTarget) => fixture.calls.filter((call) =>
  call.sessionId === session(target) && call.method === "Emulation.setFocusEmulationEnabled")
function fault(result: Awaited<ReturnType<typeof settled>>, code: string) {
  assert.equal(result.ok, false)
  if (result.ok) throw new Error("Expected an interrupted input")
  assert.ok(result.error instanceof BrowserFault)
  assert.equal(result.error.detail.code, code)
  assert.equal(result.error.detail.outcome, "unknown")
}

try {
  await run({ action: "connect", browser: "fixture" })

  // A real click handler can block mouseReleased's reply until the dialog is answered.
  const releaseTarget = await open()
  const release = fixture.holdNextInput("mouseReleased")
  const releaseResult = settled(click(releaseTarget))
  await bounded(release.dispatched, "Click never released its button")
  dialog(releaseTarget)
  fault(await bounded(releaseResult, "A dialog must interrupt the blocked release promptly"), "dialog-open")
  assert.deepEqual(inputs(releaseTarget).map((call) => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"])
  assert.deepEqual(focusChanges(releaseTarget).map((call) => call.params.enabled), [true], "Do not reset focus while the modal blocks renderer acknowledgements")
  assert.equal(fixture.calls.some((call) => call.method === "Target.detachFromTarget" && call.params.sessionId === session(releaseTarget)), false)
  await run({ action: "dialog", target: releaseTarget, respond: "dismiss" })
  await until(() => focusChanges(releaseTarget).some((call) => call.params.enabled === false), "Closing the dialog did not reset action focus")
  assert.deepEqual(focusChanges(releaseTarget).map((call) => call.params.enabled), [true, false], "Reset action focus exactly once after the dialog closes")
  await assert.rejects(click(releaseTarget), /outcome is unknown/)
  release.complete() // A late acknowledgement must not erase uncertainty or replay input.
  await assert.rejects(click(releaseTarget), /outcome is unknown/)
  await run({ action: "observe", target: releaseTarget })
  await click(releaseTarget)
  assert.equal(inputs(releaseTarget).filter((call) => call.params.type === "mouseReleased").length, 2)

  // Answering the first modal can synchronously open another one before ACK.
  const nestedTarget = await open()
  const nestedRelease = fixture.holdNextInput("mouseReleased")
  const nestedResult = settled(click(nestedTarget))
  await bounded(nestedRelease.dispatched, "Nested-dialog click never released")
  dialog(nestedTarget)
  fault(await nestedResult, "dialog-open")
  fixture.page.nextDialog = "Second confirmation"
  const second = await run({ action: "dialog", target: nestedTarget, respond: "accept" })
  assert.match(JSON.stringify(second), /Second confirmation/)
  assert.deepEqual(focusChanges(nestedTarget).map((call) => call.params.enabled), [true])
  await run({ action: "dialog", target: nestedTarget, respond: "dismiss" })
  nestedRelease.complete()
  assert.deepEqual(focusChanges(nestedTarget).map((call) => call.params.enabled), [true, false])

  // Dialogs on mouse-down still need exactly one button-up cleanup.
  const pressTarget = await open()
  const press = fixture.holdNextInput("mousePressed")
  const pressResult = settled(click(pressTarget))
  await bounded(press.dispatched, "Click never pressed its button")
  dialog(pressTarget)
  fault(await bounded(pressResult, "A down-handler dialog must not hold the button"), "dialog-open")
  await until(() => inputs(pressTarget).some((call) => call.params.type === "mouseReleased"), "Interrupted mouse-down cleanup was not dispatched")
  assert.deepEqual(inputs(pressTarget).map((call) => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"])
  press.complete()
  await run({ action: "dialog", target: pressTarget, respond: "dismiss" })

  // Remember the opening even if another actor closes it in the same event burst.
  const closedTarget = await open()
  const closedRelease = fixture.holdNextInput("mouseReleased")
  const closedResult = settled(click(closedTarget))
  await bounded(closedRelease.dispatched, "Click never reached its release")
  dialog(closedTarget)
  fixture.emit(session(closedTarget), "Page.javascriptDialogClosed", { result: false })
  fault(await bounded(closedResult, "An immediately closed dialog lost its interruption"), "dialog-open")
  closedRelease.complete()
  await assert.rejects(click(closedTarget), /outcome is unknown/)

  // A different page's modal must not settle this page's held request.
  const unrelatedTarget = await open()
  const otherTarget = await open()
  const unrelatedRelease = fixture.holdNextInput("mouseReleased")
  let unrelatedSettled = false
  const unrelatedResult = settled(click(unrelatedTarget)).then((result) => { unrelatedSettled = true; return result })
  await bounded(unrelatedRelease.dispatched, "Click never reached its release")
  dialog(otherTarget)
  await run({ action: "dialog", target: otherTarget }) // Round-trip after the event.
  assert.equal(unrelatedSettled, false)
  unrelatedRelease.complete()
  assert.equal((await bounded(unrelatedResult, "Acknowledged input did not finish")).ok, true)
  await run({ action: "dialog", target: otherTarget, respond: "dismiss" })

  // Automatic dialog policy still waits for the actual input acknowledgement.
  const autoTarget = await open()
  await run({ action: "dialog", target: autoTarget, auto: "dismiss" })
  const answersBeforeAuto = fixture.page.dialogAnswers.length
  const autoRelease = fixture.holdNextInput("mouseReleased")
  let autoSettled = false
  const autoResult = settled(click(autoTarget)).then((result) => { autoSettled = true; return result })
  await bounded(autoRelease.dispatched, "Auto-policy click never released")
  dialog(autoTarget)
  await until(() => fixture.page.dialogAnswers.length > answersBeforeAuto, "Automatic policy did not answer the dialog")
  assert.equal(autoSettled, false)
  assert.equal(fixture.page.dialogAnswers.at(-1)?.accept, false)
  autoRelease.complete()
  assert.equal((await bounded(autoResult, "Auto-policy input did not finish after acknowledgement")).ok, true)

  const cancelledTarget = await open()
  const beforeCancel = inputs(cancelledTarget).length
  const preabort = new AbortController()
  preabort.abort()
  await assert.rejects(click(cancelledTarget, preabort.signal))
  assert.equal(inputs(cancelledTarget).length, beforeCancel)
  const cancelledPress = fixture.holdNextInput("mousePressed")
  const cancellation = new AbortController()
  const cancellationResult = settled(click(cancelledTarget, cancellation.signal))
  await bounded(cancelledPress.dispatched, "Cancelled click never pressed")
  cancellation.abort()
  fault(await bounded(cancellationResult, "Cancellation did not release the held button"), "cancelled")
  assert.deepEqual(inputs(cancelledTarget).map((call) => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"])
  cancelledPress.complete()

  // Enter can open a modal during keyDown. Cancellation must also let a held key go.
  for (const interrupt of ["dialog", "cancel"] as const) {
    const keyTarget = await open()
    const key = fixture.holdNextInput("keyDown")
    const cancellation = new AbortController()
    const result = settled(run({ action: "press", target: keyTarget, key: "Enter" }, cancellation.signal))
    await bounded(key.dispatched, "Enter never reached keyDown")
    if (interrupt === "dialog") dialog(keyTarget)
    else cancellation.abort()
    fault(await bounded(result, "An interrupted keyDown did not clean up"), interrupt === "dialog" ? "dialog-open" : "cancelled")
    await until(() => inputs(keyTarget).some((call) => call.params.type === "keyUp"), "Interrupted key-down cleanup was not dispatched")
    assert.deepEqual(inputs(keyTarget).map((call) => call.params.type), ["keyDown", "keyUp"])
    key.complete()
    if (interrupt === "dialog") await run({ action: "dialog", target: keyTarget, respond: "dismiss" })
  }

  const keyUpTarget = await open()
  const keyUp = fixture.holdNextInput("keyUp")
  const keyUpResult = settled(run({ action: "press", target: keyUpTarget, key: "Enter" }))
  await bounded(keyUp.dispatched, "Enter never reached keyUp")
  dialog(keyUpTarget)
  fault(await bounded(keyUpResult, "A keyUp dialog must interrupt promptly"), "dialog-open")
  assert.deepEqual(inputs(keyUpTarget).map((call) => call.params.type), ["keyDown", "keyUp"])
  keyUp.complete()
  await run({ action: "dialog", target: keyUpTarget, respond: "dismiss" })

  // An explicit release rejection is returned, never retried into apparent success.
  const rejectedTarget = await open()
  const rejectedRelease = fixture.holdNextInput("mouseReleased")
  const rejectedResult = settled(click(rejectedTarget))
  await bounded(rejectedRelease.dispatched, "Click never reached the rejected release")
  rejectedRelease.complete("Input rejected by fixture")
  const rejected = await bounded(rejectedResult, "Rejected release did not settle")
  assert.equal(rejected.ok, false)
  assert.equal(inputs(rejectedTarget).filter((call) => call.params.type === "mouseReleased").length, 1)

  // Recording feedback follows dispatch, including inputs whose reply never arrives.
  const connection = await BrowserConnection.connect(await fixture.definition.endpoint(), AbortSignal.timeout(1000))
  try {
    const feedback: { pressed: boolean }[] = []
    const unsubscribe = connection.onInput((event) => feedback.push(event))
    const held = fixture.holdNextInput("mousePressed")
    const cancellation = new AbortController()
    const result = settled(connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, buttons: 1 }, cancellation.signal))
    await bounded(held.dispatched, "Direct input was not dispatched")
    assert.deepEqual(feedback.map((event) => event.pressed), [true])
    cancellation.abort()
    fault(await bounded(result, "Direct input did not cancel"), "cancelled")
    held.complete()
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 2, buttons: 0 }, AbortSignal.timeout(1000))
    assert.deepEqual(feedback.map((event) => event.pressed), [true, false])
    unsubscribe()
  } finally { connection.close() }

  console.log("Browser modal input: event-driven interruption, exact-session scope, one release, key cleanup, cancellation, late replies, uncertainty and dispatch-time feedback verified")
} finally {
  service.close()
  await fixture.close()
}
