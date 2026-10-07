import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ANSWERED_DIFFERENTLY, type ApprovalSubmission } from "../electron/contracts/approval-response.js"
import type { PlanBuild } from "../electron/contracts/plan-builds.js"
import { LiveConversations } from "../electron/live-conversations.js"
import type { LivePermissionResponse, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.js"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Two people answer one plan approval. The host keeps the first answer, and
// records the plan built only when that answer approved it and reached the agent.
const root = mkdtempSync(join(tmpdir(), "mako-plan-approvals-"))
try {
  for (const scenario of ["approve-first", "keep-planning-first", "keep-planning-with-words", "unconfirmed"] as const) {
    const id = randomUUID()
    const builds: Array<{ plan: string; build: PlanBuild; pending: boolean }> = []
    const gate = Promise.withResolvers<void>()
    let calls = 0
    const received: LivePermissionResponse[] = []
    const submission: ApprovalSubmission | undefined = scenario === "unconfirmed" ? undefined : { kind: "submitted", source: "callback" }
    const state: LiveSessionState = { id, harness: "claude", cwd: root, status: "running", connection: "connected", nativeRunId: "run", modes: [], currentMode: null, configOptions: [] }
    const driver: ProviderLiveDriver = {
      ...noCapabilities,
      resume: fixtureResume(),
      launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
      nativeExclusion: NO_NATIVE_EXCLUSION,
      nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
      backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
      turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
      provider: "claude", available: () => true,
      start: async () => state,
      prompt: async () => {}, close() {}, cancel: async () => {}, setMode: async () => {},
      async permission(_binding, _native, response, dispatch) {
        dispatch.assertCurrent()
        calls++
        received.push(response)
        await gate.promise
        if (submission) dispatch.report(submission)
      },
    }
    const owner: LiveConversations = new LiveConversations({
      root: join(root, scenario), appPath: root, driver: () => driver, history: async () => null, emit: () => {},
      planBuilt: (plan, build) => builds.push({ plan, build, pending: Boolean(owner.snapshot(id)?.permissions.length) }),
    })
    try {
      await owner.start("claude", root, { conversationId: id })
      for (let i = 0; i < 100 && owner.snapshot(id)?.session.connection !== "connected"; i++) await delay(5)
      owner.observe({ type: "live-permission", request: {
        id: "native-request", sessionId: id, title: "Start implementing the proposed plan?", kind: "ExitPlanMode",
        options: [{ optionId: "allow_once", name: "Approve plan", kind: "allow_once" }, { optionId: "reject_once", name: "Keep planning", kind: "reject_once" }],
        implementsPlan: { plan: "plan-1", approve: "allow_once" }, feedbackOption: "reject_once",
      } })
      const request = owner.snapshot(id)?.permissions.at(-1)?.id
      assert.ok(request)
      const approve = { kind: "choice", optionId: "allow_once" } as const
      const keep = { kind: "choice", optionId: "reject_once" } as const
      const words = { ...keep, feedback: "Split the migration into two steps" }
      assert.equal(owner.snapshot(id)?.permissions.at(-1)?.feedbackOption, "reject_once", "the window learns which answer takes words")
      const [first, second] = scenario === "keep-planning-first" ? [keep, approve] : scenario === "keep-planning-with-words" ? [words, approve] : [approve, keep]
      const answering = owner.permission(id, request, first)
      await assert.rejects(owner.permission(id, request, second), (error: Error) => error.message.includes(ANSWERED_DIFFERENTLY),
        `${scenario}: the second person's different answer is refused, in words their window recognizes`)
      await assert.rejects(owner.permission(id, request, first), /already saved/, `${scenario}: the same answer twice is one answer`)
      if (scenario === "keep-planning-with-words")
        await assert.rejects(owner.permission(id, request, { ...keep, feedback: "Something else" }), /already saved/,
          "a second click with other words is the same decision, not a conflicting one")
      if (scenario === "keep-planning-with-words")
        await assert.rejects(owner.permission(id, request, { ...keep, feedback: "Something else" }), /already saved/,
          "a second click with other words is the same decision, not a conflicting one")
      gate.resolve()
      if (scenario === "unconfirmed") await assert.rejects(answering, /did not confirm/)
      else await answering
      assert.equal(calls, 1, `${scenario}: the agent hears one answer`)
      assert.deepEqual(received, [first], `${scenario}: the driver gets the answer as given, words included`)
      assert.deepEqual(received, [first], `${scenario}: the driver gets the answer as given, words included`)
      if (scenario === "approve-first") {
        assert.equal(builds.length, 1, "an approval the agent took records its plan built, once")
        assert.equal(builds[0]?.plan, "plan-1")
        assert.equal(builds[0]?.build.conversation, id)
        assert.ok(builds[0]?.pending, "the build is recorded before the approval leaves the snapshot, so no window sees it unbuilt and unanswered")
        await owner.permission(id, request, approve)
        assert.equal(builds.length, 1, "a late identical click records nothing more")
      } else {
        assert.deepEqual(builds, [], `${scenario}: nothing is recorded built`)
      }
    } finally {
      owner.close(id)
    }
  }
  console.log("Plan approvals: first answer wins across windows, the loser is told, words reach the driver, and only a confirmed approve records the build")
} finally {
  rmSync(root, { recursive: true, force: true })
}
