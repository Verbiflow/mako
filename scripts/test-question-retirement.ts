import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { latestPendingQuestion, retireQuestionsForInput } from "../electron/contracts/live-questions.js"
import { codexAsyncQuestion, codexQuestionAnswer } from "../electron/providers/codex/questions.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { LiveSessionState } from "../electron/shared.js"

const root = await mkdtemp(join(tmpdir(), "mako-question-retirement-"))
try {
  for (const provider of ["claude", "codex", "cursor", "grok", "devin", "opencode", "future"]) {
    const id = randomUUID(), path = join(root, provider + ".native")
    await writeFile(path, "native")
    let state: LiveSessionState = { id, harness: provider, cwd: root, nativeId: "native", nativePath: path, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
    let prompts = 0
    const driver: ProviderLiveDriver = {
      provider, available: () => true, canResume: true, approvalEvidence: { kind: "submission-only", reason: "Fixture" },
      sessionQuestions: { encodeAnswer: codexQuestionAnswer },
      start: async () => state,
      prompt: async (_id, _text, _attachments, _settings, dispatch) => {
        prompts++
        state = { ...state, status: "running", nativeRunId: randomUUID() }
        owner.observe({ type: "live-session", session: state })
        dispatch.report({ kind: "accepted", source: "native-response", referenceId: state.nativeRunId })
      },
      permission: async () => { throw Error("Unexpected permission write") },
      close() {}, cancel: async () => {}, setMode: async () => {},
    }
    const deps = { root: join(root, provider), appPath: root, driver: () => driver, history: async () => null, emit() {}, checkpoint: async () => "same" }
    let owner = new LiveConversations(deps)
    const snapshot = () => owner.snapshot(id)!
    const current = () => latestPendingQuestion(snapshot().control!, snapshot().requests)
    const ask = (item: string) => {
      owner.observe({ type: "live-question", id, question: codexAsyncQuestion("native", item, item, [{ title: item }]) })
      return snapshot().control!.questions!.find(q => q.native.itemId === item)!
    }
    const waitPrompts = async (count: number) => {
      for (let n = 0; n < 100 && prompts < count; n++) await delay(5)
      assert.equal(prompts, count)
    }
    try {
      await owner.start(provider, root, { conversationId: id })
      for (let n = 0; n < 100 && snapshot().session.connection !== "connected"; n++) await delay(5)
      const old = ask("old"), older = ask("older")
      state = { ...state, status: "ready" }; owner.observe({ type: "live-session", session: state })
      assert.equal(current()?.id, older.id, "Turn completion alone does not erase optional native questions")
      owner.submit(id, randomUUID(), "Move on with the next task")
      await waitPrompts(1)
      assert.equal(current(), undefined, "Ordinary accepted input retires every older question")
      assert.ok(ask("old").retired, "Late replay cannot restore a retired question")
      const writes = prompts
      await assert.rejects(owner.permission(id, old.id, { kind: "answers", answers: { [old.native.questions[0]!.id]: ["stale"] } }), /no longer available/)
      assert.equal(prompts, writes)
      ask("during-running-turn")
      owner.submit(id, randomUUID(), "Queued follow-up")
      assert.equal(current(), undefined, "Queue admission retires questions without waiting for execution")
      const late = ask("arrived-after-enqueue")
      assert.equal(current()?.id, late.id)
      state = { ...state, status: "ready" }; owner.observe({ type: "live-session", session: state })
      await waitPrompts(2)
      assert.equal(current(), undefined, "Queue dispatch retires questions that arrived after enqueue")
      const fresh = ask("fresh")
      const before = snapshot().control!
      const cohort = before.questions!
      const newest = ask("newer-than-steer")
      const retired = retireQuestionsForInput(snapshot().control!, randomUUID(), cohort)
      assert.equal(latestPendingQuestion(retired, snapshot().requests)?.id, newest.id, "Late steering acceptance preserves a newer question")
      assert.equal(retireQuestionsForInput(before, fresh.id), before, "Answer delivery does not retire other pending questions")
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      driver.sessionQuestions!.history = async () => {
        await gate
        return [{ question: codexAsyncQuestion("native", "missed-old", "missed-old", [{ title: "Old history arriving late" }]), answered: [] }]
      }
      const reading = owner.refreshedSnapshot(id)
      owner.submit(id, randomUUID(), "A newer accepted message during the read")
      const afterReadStarted = ask("new-after-history-started")
      release(); await reading
      assert.ok(!snapshot().control!.questions!.some(q => q.native.itemId === "missed-old"), "A pre-input history read cannot introduce an older prompt afterward")
      assert.equal(current()?.id, afterReadStarted.id)
      delete driver.sessionQuestions!.history
      owner.stop(); owner = new LiveConversations(deps)
      assert.ok(snapshot().control!.questions!.find(q => q.id === old.id)?.retired, "Retirement is journaled across owner restart")
      assert.equal(current()?.id, afterReadStarted.id)
      await owner.permission(id, afterReadStarted.id, { kind: "choice", optionId: null })
      await owner.permission(id, newest.id, { kind: "choice", optionId: null })
      await owner.permission(id, fresh.id, { kind: "choice", optionId: null })
      assert.equal(current(), undefined, "Dismissing current questions cannot uncover retired historical forms")
      assert.equal(snapshot().control!.questions!.find(q => q.id === old.id)?.answered, undefined, "Presentation retirement never fabricates a native answer")
      console.log(`${provider}: ordinary/queued input, dispatch, stale answer, replay, late cohort, answer exclusion and restart passed`)
    } finally { owner.stop() }
  }
} finally { await rm(root, { recursive: true, force: true }) }
