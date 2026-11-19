// How often Mako's note goes, through LiveConversations with an injected
// driver: its standing lines whole on a transcript's first prompt, then only
// what changed, nothing when nothing did, also in a new process resuming the
// same native session; whole again after a compaction or a rewind, in a new
// native session, another binding or folder; notices once each.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { makoNote } from "@mako/host/conversations/mako-note"
import { CHANGED_LINE, heardBy, noteHeard, REPLACED_LINE, standingLines } from "@mako/host/conversations/control-cadence"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"
const CONTROL = "Browser and computer use: fixture."
const ENVIRONMENT = "This Thread's own values: ports 21150-21159."
const MEDIA = "To show the person media you made, embed it."

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

const noted = (lines: string[], text: string) => `<mako-local-control>\n${lines.join("\n")}\n</mako-local-control>\n\n${text}`

/** The fixture's standing lines, which a test changes between prompts. */
interface Standing {
  control: string
  environment: string
  media?: string
}

/** `idleMs`: the process hibernates once idle that long, and the next message resumes its session in a new one. */
function cadenceHost(options: { idleMs?: number; beforeInstructions?(): Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-control-cadence-"))
  const id = randomUUID()
  const sent: string[] = []
  const standing: Standing = { control: CONTROL, environment: ENVIRONMENT, media: MEDIA }
  const notices: string[] = []
  const native = { id }
  let starts = 0
  let refuse = false
  let owner: LiveConversations
  const state = (status: LiveSessionState["status"], connection: LiveSessionState["connection"] = "connected"): LiveSessionState => ({
    id, nativeId: native.id, nativePath: join(root, "native-session", native.id), harness: "test-provider", cwd: root, status, connection, modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: FIXTURE },
    launchEnvironment: { kind: "unavailable", reason: FIXTURE },
    nativeIdentity: { kind: "unavailable", reason: FIXTURE },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: FIXTURE, feedback: { kind: "next-message", reason: FIXTURE } },
    backgroundStop: { kind: "ends-with-turn", evidence: FIXTURE },
    turnRecovery: { kind: "manual", reason: FIXTURE },
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async () => {
      starts += 1
      return state("ready")
    },
    prompt: async (_id, text, _attachments, _settings, dispatch) => {
      if (refuse) {
        refuse = false
        throw new Error("The harness refused the message")
      }
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      owner.observe({ type: "live-session", session: state("running") })
      owner.observe({ type: "live-update", id, update: { kind: "text", text: "Done." } })
      // The turn ends after the send returns, as a harness's does, so an idle process can hibernate.
      setTimeout(() => owner.observe({ type: "live-session", session: state("ready") }), 0)
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  const note = makoNote({
    cloudMachine: false, launchedWith: () => undefined, controlLine: () => undefined, ownSlot: () => true,
    notices: async () => { await options.beforeInstructions?.(); return notices.splice(0) },
  })
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    controlInstructions: async () => ({ ...await note("fixture-binding", id, { role: "thread" }), standing: { ...standing } }),
    ...options.idleMs !== undefined && {
      providerIdleMs: options.idleMs,
      resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }),
    },
  })
  const settled = () => (owner.snapshot(id)?.requests ?? []).every((request) => request.status === "completed" || request.status === "failed")
  return {
    id,
    owner,
    standing,
    notices,
    native,
    sent: () => [...sent],
    starts: () => starts,
    hibernated: () => owner.snapshot(id)?.session.connection === "hibernated",
    start: () => owner.start("test-provider", root, { conversationId: id }),
    /** The text the harness got for `text`. */
    send: async (text: string) => {
      const before = sent.length
      owner.submit(id, randomUUID(), text)
      await waitFor(() => sent.length === before + 1 && settled(), `"${text}" never went`)
      return sent.at(-1)!
    },
    /** A send the harness refuses; the person's next message retries. */
    refused: async (text: string) => {
      refuse = true
      owner.submit(id, randomUUID(), text)
      await waitFor(() => owner.snapshot(id)?.session.status === "failed", `"${text}" was never refused`)
    },
    observe: (event: Parameters<LiveConversations["observe"]>[0]) => owner.observe(event),
    cleanup: async () => {
      await owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function theRule() {
  const at = { bindingId: "binding", generation: 1 }
  const first = standingLines(undefined, at, { control: CONTROL, environment: ENVIRONMENT, absent: undefined })
  assert.deepEqual(first.lines, [CONTROL, ENVIRONMENT], "a transcript that holds nothing hears every line that applies")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: ENVIRONMENT }).lines, [], "nothing changed, nothing said")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: "Moved." }).lines, [CHANGED_LINE, "Moved."], "a changed line goes alone")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: ENVIRONMENT, media: MEDIA }).lines, [CHANGED_LINE, MEDIA], "a new line goes alone")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL }).lines, [REPLACED_LINE, CONTROL], "a line gone sends the rest whole, replacing what was said")

  // Which record a prompt reads (`heardBy`): the process's own, else the journal's for the same native session.
  const target = { ...at, nativeId: "native-1", cwd: "/work" }
  const kept = noteHeard(first.said, "native-1", "/work")
  assert.equal(heardBy(first.said, undefined, target), first.said, "the same start of the same binding reads its own record")
  const resumed = heardBy(undefined, kept, { ...target, generation: 2 })
  assert.deepEqual(resumed?.lines, first.said.lines, "a new process in the same native session reads what the transcript holds")
  assert.deepEqual(standingLines(resumed, { ...at, generation: 2 }, { control: CONTROL, environment: ENVIRONMENT }).lines, [], "and hears nothing again")
  assert.deepEqual(heardBy(first.said, kept, { ...target, generation: 2 })?.lines, first.said.lines, "an older process's record yields to the journal's")
  assert.equal(heardBy(undefined, kept, { ...target, generation: 2, nativeId: "native-2" }), undefined, "a new native session holds nothing")
  assert.equal(heardBy(undefined, kept, { ...target, generation: 2, nativeId: undefined }), undefined, "a session not yet named holds nothing")
  assert.equal(heardBy({ ...first.said, nativeId: "native-1" }, undefined, { ...target, nativeId: "native-2" }), undefined, "a new native session in the same process holds nothing")
  assert.equal(heardBy(undefined, kept, { ...target, bindingId: "other" }), undefined, "another binding (a harness switch) holds nothing")
  assert.equal(heardBy(undefined, kept, { ...target, generation: 2, cwd: "/moved" }), undefined, "a moved folder hears it whole")
  assert.ok(!JSON.stringify(kept).includes(CONTROL), "the journal keeps fingerprints, never the lines")
}

async function throughTheConversation() {
  const host = cadenceHost()
  const full = [CONTROL, ENVIRONMENT, MEDIA]
  try {
    await host.start()
    assert.equal(await host.send("First"), noted(full, "First"), "the first prompt carries the whole note")
    assert.equal(await host.send("Second"), "Second", "an unchanged note isn't sent again")

    host.standing.environment = "This Thread's own values: ports 21160-21169."
    assert.equal(await host.send("Third"), noted([CHANGED_LINE, host.standing.environment], "Third"), "a changed line goes as a delta")
    assert.equal(await host.send("Fourth"), "Fourth")

    host.notices.push("Moved to its own worktree.")
    assert.equal(await host.send("Fifth"), noted(["Moved to its own worktree."], "Fifth"), "a notice goes when it happens")
    assert.equal(await host.send("Sixth"), "Sixth", "and once")

    const now = [CONTROL, host.standing.environment, MEDIA]
    host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } })
    assert.equal(await host.send("After compacting"), noted(now, "After compacting"), "after a compaction the whole note again")
    assert.equal(await host.send("Then"), "Then")

    host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, status: "running" } })
    host.observe({ type: "live-activity", id: host.id, activity: { kind: "compacting" } })
    host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, status: "ready" } })
    assert.equal(await host.send("After its own compaction"), noted(now, "After its own compaction"), "a compaction the harness starts counts too")

    host.observe({ type: "live-rewound", id: host.id, run: "run-1" })
    assert.equal(await host.send("After a rewind"), noted(now, "After a rewind"), "a rewound history may have dropped the note")

    await host.refused("Refused")
    assert.equal(await host.send("After a refusal"), "After a refusal", "a refused send changes nothing the transcript holds")

    host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } })
    await host.refused("Refused after compacting")
    assert.equal(await host.send("Retried"), noted(now, "Retried"), "a note a refused send carried goes again, whole")

    host.standing.media = undefined
    assert.equal(await host.send("Without media"), noted([REPLACED_LINE, CONTROL, host.standing.environment!], "Without media"), "a line that stops applying sends the rest whole")
  } finally {
    await host.cleanup()
  }
}

async function afterARelaunch() {
  const host = cadenceHost({ idleMs: 15 })
  const full = [CONTROL, ENVIRONMENT, MEDIA]
  const relaunch = async (text: string) => {
    await waitFor(host.hibernated, "the idle provider never hibernated")
    const starts = host.starts()
    const sent = await host.send(text)
    assert.equal(host.starts(), starts + 1, "the harness was started again")
    return sent
  }
  try {
    await host.start()
    assert.equal(await host.send("First"), noted(full, "First"))
    assert.equal(await relaunch("Resumed"), "Resumed", "a new process resuming the same native session hears nothing again")
    assert.equal(await relaunch("Again"), "Again", "nor on the next")

    host.notices.push("Moved to its own worktree.")
    assert.equal(await relaunch("With a notice"), noted(["Moved to its own worktree."], "With a notice"), "a new notice still arrives in a new process")

    host.standing.environment = "This Thread's own values: ports 21160-21169."
    assert.equal(await relaunch("Changed"), noted([CHANGED_LINE, host.standing.environment], "Changed"), "a line that changed goes as a delta in a new process")
    const now = [CONTROL, host.standing.environment, MEDIA]

    host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } })
    assert.equal(await relaunch("After compacting"), noted(now, "After compacting"), "a compaction before the new process sends it whole")

    // The harness started a new native session under the binding (a /clear, a session it couldn't resume).
    host.native.id = randomUUID()
    host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, nativeId: host.native.id } })
    host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, status: "ready" } })
    assert.equal(await host.send("New session"), noted(now, "New session"), "a new native session hears it whole, in the same process too")
    assert.equal(await relaunch("Resumed again"), "Resumed again", "and once heard there, a new process resuming it hears nothing again")
    assert.equal(await host.send("Then"), "Then")
  } finally {
    await host.cleanup()
  }
}

async function awaitedNotice() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const host = cadenceHost({ beforeInstructions: () => { entered.resolve(); return release.promise } })
  try {
    await host.start()
    host.notices.push("Returned with a conflict.")
    const sent = host.send("After return")
    await entered.promise
    assert.deepEqual(host.sent(), [], "the provider is not called while a notice's receipt is pending")
    release.resolve()
    assert.equal(await sent, noted([CONTROL, ENVIRONMENT, MEDIA, "Returned with a conflict."], "After return"))
    assert.equal(await host.send("Next"), "Next", "the acknowledged notice goes once")
  } finally { release.resolve(); await host.cleanup() }

  let fail = true
  const failing = cadenceHost({ beforeInstructions: async () => { if (fail) throw false } })
  try {
    await failing.start()
    failing.notices.push("Returned with a conflict.")
    assert.equal(await failing.send("Receipt failed"), noted([CONTROL, ENVIRONMENT, MEDIA], "Receipt failed"), "a failed acknowledgement must not cost the person their message")
    fail = false
    assert.equal(await failing.send("Retry"), noted(["Returned with a conflict."], "Retry"))
    assert.equal(await failing.send("Then"), "Then", "the retained notice goes once after the write succeeds")
  } finally { await failing.cleanup() }
}

theRule()
await throughTheConversation()
await afterARelaunch()
await awaitedNotice()
console.log("control cadence: the note goes whole once per native session, then only what changed, across new processes too; whole again after a compaction, a rewind, a refused send that carried it, a new native session, another binding or folder; notices once each")
