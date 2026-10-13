// Side questions through LiveConversations with an injected driver whose
// answers the test releases: streaming into the side conversation and out of
// the transcript and journal, follow-ups carrying earlier answers, one answer
// at a time, Stop settling at once while a harness that can't stop finishes
// unread, the next question and close waiting for that, and the refusals.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { SideExchange } from "@mako/host/contracts/live-side-questions"
import type { DriverSideQuestion, ProviderLiveDriver, SideQuestionsCapability } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** One question the driver was handed, and the hands to answer it with. */
interface Asked {
  question: DriverSideQuestion
  answer: (text: string) => void
  fail: (error: Error) => void
}

function sideHost(kind: "native" | "fork" | "unavailable") {
  const root = mkdtempSync(join(tmpdir(), "mako-live-side-"))
  const id = randomUUID()
  const asked: Asked[] = []
  const closed: string[] = []
  let owner: LiveConversations
  const state = (status: LiveSessionState["status"]): LiveSessionState => ({
    id, nativeId: id, harness: "test-provider", cwd: root, status, connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const sideQuestions: SideQuestionsCapability = kind === "unavailable"
    ? { kind: "unavailable", reason: "It has none." }
    : {
        kind,
        via: FIXTURE,
        ask: (_binding, question) => new Promise<string>((resolve, reject) => {
          asked.push({ question, answer: resolve, fail: reject })
        }),
        close: async (_binding, side) => { closed.push(side) },
      }
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    sideQuestions,
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
    start: async () => state("ready"),
    prompt: async () => {
      owner.observe({ type: "live-session", session: state("running") })
      owner.observe({ type: "live-update", id, update: { kind: "text", text: "Working on it." } })
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
  })
  return {
    id,
    root,
    owner,
    asked,
    closed,
    async start() {
      await owner.start("test-provider", root, { conversationId: id })
      await owner.submit(id, randomUUID(), "Remember the marker ORBIT-7.")
      await waitFor(() => owner.snapshot(id)?.session.status === "running", "the turn to start")
    },
    exchanges: (): SideExchange[] => owner.snapshot(id)?.side?.exchanges ?? [],
    ask: (question: string) => owner.sideQuestion(id, { kind: "ask", question }),
    journal: () => readdirSync(join(root, "journals"), { recursive: true }).flatMap((name) => {
      const path = join(root, "journals", String(name))
      try { return [readFileSync(path, "utf8")] } catch { return [] }
    }).join("\n"),
    dispose() {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

{
  // Before any message, there is nothing to ask about.
  const host = sideHost("native")
  await host.owner.start("test-provider", host.root, { conversationId: host.id })
  await assert.rejects(host.ask("Anything?"), /Send a message first, then ask a side question\./)
  host.dispose()
}

{
  const host = sideHost("native")
  await host.start()
  await host.ask("What marker did I ask you to remember?")
  await waitFor(() => host.asked.length === 1, "the driver to be asked")
  assert.equal(host.owner.snapshot(host.id)?.side?.by, "harness")
  assert.deepEqual(host.asked[0]!.question.earlier, [], "the first question has nothing before it")
  host.asked[0]!.question.stream("The marker ")
  host.asked[0]!.question.stream("is ORBIT-7.")
  assert.equal(host.exchanges()[0]!.answer, "The marker is ORBIT-7.", "the answer streams into the side conversation")
  assert.equal(host.exchanges()[0]!.status, "answering")
  await assert.rejects(host.ask("And another?"), /Wait for the answer, or stop it, before asking another\./)
  host.asked[0]!.answer("The marker is ORBIT-7.")
  await waitFor(() => host.exchanges()[0]?.status === "answered", "the answer to settle")
  assert.equal(host.owner.snapshot(host.id)?.session.status, "running", "the turn keeps running beside the side question")

  await host.ask("What did I just ask?")
  await waitFor(() => host.asked.length === 2, "the follow-up")
  assert.deepEqual(host.asked[1]!.question.earlier, [{ question: "What marker did I ask you to remember?", answer: "The marker is ORBIT-7." }], "a follow-up carries the answered exchanges before it")
  assert.equal(host.asked[1]!.question.side, host.asked[0]!.question.side, "follow-ups stay in one side conversation")

  // Stop shows the answer stopped at once; the driver's call runs on unread, and the next question waits for it.
  host.asked[1]!.question.stream("You asked")
  await host.owner.sideQuestion(host.id, { kind: "stop" })
  assert.equal(host.asked[1]!.question.signal.aborted, true, "the driver is told to stop")
  await waitFor(() => host.exchanges()[1]?.status === "stopped", "the answer to show stopped")
  host.asked[1]!.question.stream(" about the marker.")
  assert.equal(host.exchanges()[1]!.answer, "You asked", "a stopped answer takes no more text")
  await host.ask("Third question")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.asked.length, 2, "the next question waits for the stopped call to end")
  assert.equal(host.exchanges()[2]!.status, "answering")
  host.asked[1]!.answer("You asked about the marker.")
  await waitFor(() => host.asked.length === 3, "the next question once the stopped call ended")
  assert.deepEqual(host.asked[2]!.question.earlier.map((exchange) => exchange.question), ["What marker did I ask you to remember?"], "a stopped exchange is not carried forward")

  // A failure says the driver's reason.
  host.asked[2]!.fail(new Error("The provider closed the connection."))
  await waitFor(() => host.exchanges()[2]?.status === "failed", "the failure")
  assert.equal(host.exchanges()[2]!.error, "The provider closed the connection.")

  // None of it joins the transcript or the journal.
  const transcript = JSON.stringify(host.owner.snapshot(host.id)?.blocks)
  assert.equal(transcript.includes("What marker did I ask you to remember?"), false, "the side question is not in the transcript")
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(host.journal().includes("Remember the marker ORBIT-7."), "the conversation itself is journaled")
  for (const side of ["What marker did I ask you to remember?", "The marker is ORBIT-7.", "Third question"])
    assert.equal(host.journal().includes(side), false, `the side conversation is not journaled: ${side}`)

  await host.owner.sideQuestion(host.id, { kind: "close" })
  assert.equal(host.owner.snapshot(host.id)?.side, undefined, "close clears the side conversation")
  await waitFor(() => host.closed.length === 1, "the driver to close the side conversation")
  assert.equal(host.closed[0], host.asked[0]!.question.side)
  host.dispose()
}

{
  // Close while an answer runs stops it, and the driver closes once that call ends.
  const host = sideHost("fork")
  await host.start()
  await host.ask("How long is the parser file?")
  await waitFor(() => host.asked.length === 1, "the driver to be asked")
  assert.equal(host.owner.snapshot(host.id)?.side?.by, "fork")
  await host.owner.sideQuestion(host.id, { kind: "close" })
  assert.equal(host.asked[0]!.question.signal.aborted, true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(host.closed, [], "the copy isn't discarded while its call runs")
  host.asked[0]!.answer("400 lines.")
  await waitFor(() => host.closed.length === 1, "the copy discarded once its call ended")
  host.dispose()
}

{
  const host = sideHost("unavailable")
  await host.start()
  await assert.rejects(host.ask("Anything?"), /This agent can't answer side questions\. It has none\./)
  host.dispose()
}

console.log("Live side questions: streaming outside the transcript and journal, follow-ups, one at a time, Stop at once with the next question waiting, failures, close after the call, and the refusals")
