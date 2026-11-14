// How often Mako's note goes, through LiveConversations with an injected
// driver: its standing lines whole on a process's first prompt, then only
// what changed, nothing when nothing did, whole again after a compaction, a
// rewind, a failed send or a new process; notices once each.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { CHANGED_LINE, REPLACED_LINE, standingLines } from "@mako/host/conversations/control-cadence"
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
function cadenceHost(options: { idleMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-control-cadence-"))
  const id = randomUUID()
  const sent: string[] = []
  const standing: Standing = { control: CONTROL, environment: ENVIRONMENT, media: MEDIA }
  const notices: string[] = []
  let starts = 0
  let refuse = false
  let owner: LiveConversations
  const state = (status: LiveSessionState["status"], connection: LiveSessionState["connection"] = "connected"): LiveSessionState => ({
    id, nativeId: id, nativePath: join(root, "native-session"), harness: "test-provider", cwd: root, status, connection, modes: [], currentMode: null, configOptions: [],
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
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    controlInstructions: () => ({ standing: { ...standing }, notices: notices.splice(0) }),
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
  assert.deepEqual(first.lines, [CONTROL, ENVIRONMENT], "a process that heard nothing hears every line that applies")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: ENVIRONMENT }).lines, [], "nothing changed, nothing said")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: "Moved." }).lines, [CHANGED_LINE, "Moved."], "a changed line goes alone")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL, environment: ENVIRONMENT, media: MEDIA }).lines, [CHANGED_LINE, MEDIA], "a new line goes alone")
  assert.deepEqual(standingLines(first.said, at, { control: CONTROL }).lines, [REPLACED_LINE, CONTROL], "a line gone sends the rest whole, replacing what was said")
  assert.deepEqual(standingLines(first.said, { ...at, generation: 2 }, { control: CONTROL, environment: ENVIRONMENT }).lines, [CONTROL, ENVIRONMENT], "a new start of the process hears it whole")
  assert.deepEqual(standingLines(first.said, { ...at, bindingId: "other" }, { control: CONTROL, environment: ENVIRONMENT }).lines, [CONTROL, ENVIRONMENT], "another binding hears it whole")
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
    assert.equal(await host.send("After a refusal"), noted(now, "After a refusal"), "a send that failed may not have reached the harness")

    host.standing.media = undefined
    assert.equal(await host.send("Without media"), noted([REPLACED_LINE, CONTROL, host.standing.environment!], "Without media"), "a line that stops applying sends the rest whole")
  } finally {
    await host.cleanup()
  }
}

async function afterARelaunch() {
  const host = cadenceHost({ idleMs: 15 })
  const full = [CONTROL, ENVIRONMENT, MEDIA]
  try {
    await host.start()
    assert.equal(await host.send("First"), noted(full, "First"))
    await waitFor(host.hibernated, "the idle provider never hibernated")
    const starts = host.starts()
    assert.equal(await host.send("Resumed"), noted(full, "Resumed"), "a session resumed in a new process hears the whole note")
    assert.equal(host.starts(), starts + 1, "the harness was started again")
  } finally {
    await host.cleanup()
  }
}

theRule()
await throughTheConversation()
await afterARelaunch()
console.log("control cadence: the note goes whole once per process, then only what changed; whole again after a compaction, a rewind, a failed send or a relaunch; notices once each")
