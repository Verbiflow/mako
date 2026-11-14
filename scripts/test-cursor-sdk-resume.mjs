import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { CURSOR_SDK_PATCHES, TRANSCRIPT_BUILDS } from "./patch-cursor-sdk.mjs"

/**
 * The SDK's retry loop, as `scripts/patch-cursor-sdk.mjs` patches it, asks the
 * process's resume hook before each retry and sends its words as a user
 * message on the checkpoint instead of the empty resume; on a resend of the
 * turn's own message, after its words. The patched expression runs here
 * against stand-ins for the protocol classes, and the installed SDK must
 * carry it in both builds.
 */
const HOOK = Symbol.for("mako:cursor-sdk-resume")

class Message {
  constructor(fields = {}) {
    Object.assign(this, fields)
  }
}
const proto = { QFf: class extends Message {}, Vtf: class extends Message {}, RGk: class extends Message {}, qKo: class extends Message {}, xyI: { AGENT: 1, PLAN: 2 } }

for (const target of [TRANSCRIPT_BUILDS.esm.target, TRANSCRIPT_BUILDS.cjs.target]) {
  const { replacements } = CURSOR_SDK_PATCHES.find((patch) => patch.target === target)
  const [original, patched] = replacements.find(([from]) => from.startsWith("try{return await s.runAttempt("))
  const name = target.includes("esm") ? "qr" : "Gr"
  assert.ok(patched.startsWith(original.slice(0, -"action:g,".length)), `${target}: the patch keeps the attempt's call`)
  // The loop's names: `w` the attempt, `g` the action the SDK would send, `m` the checkpoint state, `a` the run's request id.
  const attempt = new Function("w", "g", "m", "a", "s", name, `return (async()=>{${patched}x:0})}catch(e){throw e}})()`)
  const sent = async (w, g, hook) => {
    globalThis[HOOK] = hook
    try {
      return (await attempt(w, g, "state", "request-1", { runAttempt: async ({ action }) => action }, proto))
    } finally {
      delete globalThis[HOOK]
    }
  }
  const resume = new proto.QFf({ action: { case: "resumeAction", value: new proto.qKo() } })
  const asked = []
  const words = { text: "[mako · reconnected: …]", plan: false }

  assert.equal(await sent(0, resume, async (question) => (asked.push(question), words)), resume, `${target}: the first attempt is never asked`)
  assert.equal(asked.length, 0)

  const told = await sent(1, resume, async (question) => (asked.push(question), words))
  assert.deepEqual(asked, [{ attempt: 1, action: "resumeAction", requestId: "request-1" }], `${target}: a retry asks with its attempt, action and run`)
  assert.equal(told.action.case, "userMessageAction", `${target}: the words go as a user message on the checkpoint`)
  assert.equal(told.action.value.userMessage.text, words.text)
  assert.equal(told.action.value.userMessage.mode, proto.xyI.AGENT)
  const planned = await sent(2, resume, async () => ({ text: "words", plan: true }))
  assert.equal(planned.action.value.userMessage.mode, proto.xyI.PLAN, `${target}: a planning turn's words are a planning message`)

  assert.equal(await sent(1, resume, async () => undefined), resume, `${target}: nothing to tell resumes as the SDK would`)
  assert.equal(await sent(1, resume, async () => ({ text: "" })), resume)
  assert.equal(await sent(1, resume, async () => { throw new Error("the hook broke") }), resume, `${target}: a hook that throws changes nothing`)
  assert.equal(await sent(1, resume, undefined), resume, `${target}: a process without the hook resumes as the SDK would`)

  const first = new proto.QFf({ action: { case: "userMessageAction", value: new proto.Vtf({ userMessage: new proto.RGk({ text: "Fix the build", mode: proto.xyI.PLAN, selectedContext: "files" }), requestContext: "kept" }) } })
  const resent = await sent(1, first, async () => words)
  assert.equal(resent.action.value.userMessage.text, `Fix the build\n\n${words.text}`, `${target}: a resend of the turn's message carries the words after it`)
  assert.equal(resent.action.value.userMessage.mode, proto.xyI.PLAN)
  assert.equal(resent.action.value.userMessage.selectedContext, "files")
  assert.equal(resent.action.value.requestContext, "kept")
  assert.equal(first.action.value.userMessage.text, "Fix the build", `${target}: the SDK's own action is left as it was`)

  const summarize = new proto.QFf({ action: { case: "summarizeAction", value: {} } })
  assert.equal(await sent(1, summarize, async () => words), summarize, `${target}: any other action goes as the SDK would send it`)
}

const installed = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "../..")
for (const target of [TRANSCRIPT_BUILDS.esm.target, TRANSCRIPT_BUILDS.cjs.target]) {
  const { replacements } = CURSOR_SDK_PATCHES.find((patch) => patch.target === target)
  const [, patched] = replacements.find(([from]) => from.startsWith("try{return await s.runAttempt("))
  assert.equal(readFileSync(join(installed, target), "utf8").split(patched).length - 1, 1, `${target}: the installed SDK asks the resume hook`)
}
console.log("Cursor SDK resume: each retry asks the hook, and its words go as a user message on the checkpoint, of the turn's mode, after a resent message's own; nothing, a throw or no hook resumes as the SDK would; both installed builds carry it")
