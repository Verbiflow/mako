import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_PLAN_BUILDS, type PlanBuilds as PlanBuildsState } from "../electron/contracts/plan-builds.ts"
import { PlanBuilds } from "../electron/plan-builds.ts"

const dir = mkdtempSync(join(tmpdir(), "mako-plan-builds-"))
try {
  const file = join(dir, "plan-builds.json")
  const announced: PlanBuildsState[] = []
  const builds = new PlanBuilds({ file, announce: (state) => announced.push(state) })

  builds.record("codex:t1:t1-plan", { at: 10, conversation: "live-1" })
  assert.deepEqual(builds.state(), { "codex:t1:t1-plan": { at: 10, conversation: "live-1" } })
  assert.equal(announced.length, 1, "every window hears of a build")

  builds.record("codex:t1:t1-plan", { at: 10, conversation: "live-1" })
  builds.record("codex:t1:t1-plan", { at: 5, thread: "older" })
  assert.equal(announced.length, 1, "a replayed or older build changes nothing")

  builds.record("codex:t1:t1-plan", { at: 20, thread: "native-thread" })
  assert.deepEqual(builds.state()["codex:t1:t1-plan"], { at: 20, thread: "native-thread" }, "a plan built again keeps its latest build")

  // Two Build clicks that both saw the plan unbuilt: the first claim wins, the second learns of it.
  const won = builds.claim("click-a", "plan-x", { conversation: "a" }, null)
  assert.ok(won.claimed && won.build.conversation === "a")
  const lost = builds.claim("click-b", "plan-x", { conversation: "b" }, null)
  assert.deepEqual(lost, { claimed: false, current: won.build }, "a claim on a build it didn't see loses")
  assert.deepEqual(builds.claim("click-a", "plan-x", { conversation: "a" }, null), won, "a replayed claim gets its first answer")
  const again = builds.claim("click-c", "plan-x", { conversation: "c" }, won.build.at)
  assert.ok(again.claimed && again.build.at > won.build.at, "Build again claims over the build it saw")
  builds.release("click-c")
  assert.deepEqual(builds.state()["plan-x"], won.build, "an unsent build gives the plan back its earlier build")
  builds.release("click-c")
  builds.release("click-b")
  assert.deepEqual(builds.state()["plan-x"], won.build, "releasing twice, or a claim that lost, changes nothing")
  builds.claim("click-d", "plan-y", {}, null)
  builds.record("plan-y", { at: Date.now() + 60_000, thread: "newer" })
  builds.release("click-d")
  assert.equal(builds.state()["plan-y"]?.thread, "newer", "a release never removes a build made after its claim")

  const reopened = new PlanBuilds({ file, announce: () => {} })
  assert.deepEqual(reopened.state(), builds.state(), "the record outlives the host")

  for (let index = 0; index < MAX_PLAN_BUILDS + 5; index++) reopened.record(`plan-${index}`, { at: 100 + index })
  const kept = Object.keys(reopened.state())
  assert.equal(kept.length, MAX_PLAN_BUILDS, "the host keeps the newest builds only")
  assert.ok(kept.includes(`plan-${MAX_PLAN_BUILDS + 4}`) && !kept.includes("codex:t1:t1-plan"))

  console.log("Plan builds: kept by the host, announced, replay-safe, claimed once per click, released when unsent, newest first, bounded")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
