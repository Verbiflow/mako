import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadStore } from "../packages/host/src/threads/store.ts"
import { SourceProjectPublisher } from "../packages/host/src/workspaces/source-project-publisher.ts"
import { DeviceIdSchema } from "../packages/host/src/contracts/thread-execution.ts"
import type { SourceProjectReceipt } from "@mako/protocol/source-project"

// Mandatory actual host publisher/ThreadStore regression; Git and remote transport are stand-ins.
for (const scenario of ["source-read-failure", "unknown-publish", "unknown-cancel-after", "unknown-cancel-before", "newer-revision", "foreign-journal", "busy-during-withdraw", "source-undefined", "source-null", "source-string", "unknown-cancel-before-undefined"]) {
  const root = mkdtempSync(join(process.env.MAKO_THREAD_DATA_DIR ?? tmpdir(), "source-project-host-")), device = DeviceIdSchema.parse(randomUUID())
  const threads = new ThreadStore(join(root, "host.sqlite"), { self: { kind: "device", device }, realPath: path => path })
  try {
    const conversationId = randomUUID(), placed = threads.registerJournal({ conversationId, harness: "codex", createdAt: Date.now(), bindings: [] }, { kind: "service", name: "workspace" })
    const project = "/Users/fixture/selected", source = "/Users/fixture/source", move = randomUUID()
    threads.attachWorktree({ path: project, thread: placed.thread, repoRoot: source, project: source, branch: "mako/test", base: "a".repeat(40) }, [{ path: project + "/primary", repoRoot: source + "/primary", base: "a".repeat(40) }, { path: project + "/secondary", repoRoot: source + "/secondary", base: "a".repeat(40) }])
    const plan = { move, thread: placed.thread, asked: conversationId, cloudThread: "t-selected", phase: "preparing", project, folder: project + "/primary", repository: { url: "https://github.com/owner/primary" }, checkpoint: { sha256: "a".repeat(64) }, others: [{ path: project + "/secondary", url: "https://github.com/owner/secondary", checkpoint: { sha256: "b".repeat(64) } }], sessions: threads.threadSessions(placed.thread).map(row => ({ session: row.session })) }
    mkdirSync(join(root, "cloud", "moves"), { recursive: true }); writeFileSync(join(root, "cloud", "moves", move + ".json"), JSON.stringify(plan))
    const journalPath = join(root, "source-project", move + ".json"), sourceFailure = scenario.endsWith("undefined") ? undefined : scenario === "source-null" ? null : scenario === "source-string" ? "SYNTHETIC_SOURCE_FAILURE" : { kind: "SOURCE" }, unknown = { kind: "DELIVERY" }, actions: string[] = []
    let signalCancel: (() => void) | undefined, finishCancel: (() => void) | undefined
    const reachedCancel = new Promise<void>(resolve => { signalCancel = resolve }), cancellationReply = new Promise<void>(resolve => { finishCancel = resolve })
    let broken = false, held: SourceProjectReceipt | undefined
    const options = { dataRoot: root, threads, git: { output: async (path: string) => { if (broken) throw sourceFailure; return "https://github.com/owner/" + path.split("/").at(-1) } }, now: Date.now }
    const publisher = () => new SourceProjectPublisher({ ...options, send: async input => {
      actions.push(input.action)
      if (input.action === "publish") {
        assert.equal(input.selection.destination, "t-selected"); assert.equal(input.selection.locators.length, 2)
        held = { move, revision: input.revision, digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"), phase: "ready", expiresAt: input.expiresAt, historical: false, secondaryAdmission: false }
        if (scenario === "busy-during-withdraw") { plan.others[0]!.checkpoint.sha256 = "c".repeat(64); writeFileSync(join(root, "cloud", "moves", move + ".json"), JSON.stringify(plan)) }
        else if (scenario !== "newer-revision" && scenario !== "foreign-journal") broken = true
        if (scenario === "unknown-publish") throw unknown
      } else {
        if (!held || input.move !== held.move || input.revision !== held.revision || input.digest !== held.digest) throw new Error("not-owned")
        if (input.action === "invalidate") {
          if (scenario === "busy-during-withdraw") { signalCancel?.(); await cancellationReply }
          if (scenario.startsWith("unknown-cancel-before")) throw unknown
          held = { ...held, phase: "invalidated", historical: true }
          if (scenario === "unknown-cancel-after") throw unknown
        }
      }
      if (!held) throw new Error("missing-record")
      return structuredClone(held)
    } })
    if (scenario === "busy-during-withdraw") {
      const instance = publisher(), first = instance.publish(move)
      // Attach rejection immediately; release a blocked fake response even if the assertion fails.
      const result = assert.rejects(first, /source-changed-after-publication/)
      try { await reachedCancel; await assert.rejects(instance.publish(move), /source-publisher-busy/) }
      finally { finishCancel?.(); await result }
      assert.deepEqual(actions, ["publish", "invalidate"]); continue
    }
    if (scenario === "newer-revision" || scenario === "foreign-journal") {
      await publisher().publish(move); assert.ok(held)
      if (scenario === "newer-revision") held = { ...held, revision: 2 }
      else {
        const journal = JSON.parse(readFileSync(journalPath, "utf8")); journal.command.selection.move = randomUUID(); journal.digest = createHash("sha256").update(JSON.stringify(journal.command)).digest("hex"); writeFileSync(journalPath, JSON.stringify(journal))
      }
      broken = true
    }
    if (scenario === "unknown-publish") await assert.rejects(publisher().publish(move), error => error === unknown)
    const before = actions.length
    await assert.rejects(publisher().publish(move), error => scenario === "foreign-journal" || error === sourceFailure)
    assert.equal(actions.filter(action => action === "publish").length, 1)
    if (scenario === "foreign-journal") { assert.equal(actions.length, before); assert.equal(held?.phase, "ready"); continue }
    const phase = JSON.parse(readFileSync(journalPath, "utf8")).phase
    const uncertain = scenario.startsWith("unknown-cancel-") || scenario === "newer-revision"
    assert.equal(phase, uncertain ? "withdrawing" : "invalidated")
    if (scenario === "newer-revision") { assert.equal(held?.revision, 2); assert.equal(held?.phase, "ready") }
    else assert.equal(held?.phase, scenario.startsWith("unknown-cancel-before") ? "ready" : "invalidated")
    broken = false
    const calls = actions.length; await assert.rejects(publisher().publish(move))
    assert.equal(actions.length, calls + (uncertain ? 1 : 0)); if (uncertain) assert.equal(actions.at(-1), "read")
  } finally { threads.close(); rmSync(root, { recursive: true, force: true }) }
}
