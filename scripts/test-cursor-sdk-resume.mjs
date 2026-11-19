import assert from "node:assert/strict"
import { installedPatch, readSdk, sdkFiles } from "./lib/cursor-sdk-sites.mjs"

/**
 * The SDK's retry loop, as `scripts/patch-cursor-sdk.mjs` patches it, asks the
 * process's resume hook before each retry and sends its words as a user
 * message on the checkpoint instead of the empty resume; on a resend of the
 * turn's own message, after its words. The patched expression, as the
 * installed SDK carries it in each build and with the names that release gives
 * the loop's variables, runs here against stand-ins for the protocol classes.
 */
const HOOK = Symbol.for("mako:cursor-sdk-resume")

class Message {
  constructor(fields = {}) {
    Object.assign(this, fields)
  }
}
const proto = { QFf: class extends Message {}, Vtf: class extends Message {}, RGk: class extends Message {}, qKo: class extends Message {}, xyI: { AGENT: 1, PLAN: 2 } }

for (const build of ["esm", "cjs"]) {
  // Throws when the installed SDK lacks the patch.
  const { file: target, source, sites } = installedPatch(readSdk, sdkFiles, "resume-account", build)
  const [{ from: original, to: patched, index, length, names }] = sites
  assert.ok(patched.startsWith(original.slice(0, -"action:w,".length)), `${target}: the patch keeps the attempt's call`)
  // 1.4.0's loop: `y` the attempt, `w` the action, `g` the checkpoint, `c` the run's request id, `s` the attempt's
  // runner and `i` the protocol module; each by the name this release gives it.
  const name = (old) => names.get(old) ?? assert.fail(`${target}: the resume account binds no ${old}`)
  const attempt = new Function(name("y"), name("w"), name("g"), name("c"), name("s"), name("i"), `return (async()=>{${source.slice(index, index + length)}x:0})}catch(e){throw e}})()`)
  const sent = async (w, g, hook) => {
    globalThis[HOOK] = hook
    try {
      return (await attempt(w, g, "state", "request-1", { runAttempt: async ({ state, action }) => {
        assert.equal(state, "state", `${target}: recovery keeps the SDK's checkpoint`)
        return action
      } }, proto))
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

console.log("Cursor SDK resume: each retry asks the hook, and its words go as a user message on the checkpoint, of the turn's mode, after a resent message's own; nothing, a throw or no hook resumes as the SDK would; both installed builds carry it")
