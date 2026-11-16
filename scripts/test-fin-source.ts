import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { Git } from "@mako/git"
import type { Json } from "@mako/protocol"
import { captureFinSource, checkedFinSource, FinSourceError, sealFinSource, verifyFinSource } from "@mako/host/conversations/fin-source"
import { ORCHESTRATION_VERSION, type AgentsPlaceInput } from "@mako/host/contracts/agents"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { AgentsWorld } from "./lib/agents-world"
import { AgentPlaces } from "@mako/host/conversations/agent-places"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-fin-source-")))
const repo = join(root, "apex"), remote = join(root, "remote.git"), clone = join(root, "clone")
const url = "https://github.com/acme/source", git = new Git()
const run = (cwd: string, ...args: string[]) => git.output(cwd, args)
const reason = (wanted: FinSourceError["reason"]) => (error: Error) => error instanceof FinSourceError && error.reason === wanted
const commit = async (text: string) => {
  await writeFile(join(repo, "src/file"), text)
  await run(repo, "add", ".")
  await run(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture")
}
try {
  await mkdir(join(repo, "src"), { recursive: true })
  await run(repo, "init", "-q", "-b", "main")
  await commit("first")
  await run(root, "clone", "--bare", "--", repo, remote)
  await run(repo, "remote", "add", "origin", url)
  // Git really fetches the local bare remote; no network, provider or account is used.
  await run(repo, "config", `url.${remote}.insteadOf`, url)
  const first = await captureFinSource(git, join(repo, "src"))
  assert.equal(first.cwd, "src")
  assert.equal(first.repository.url, url)
  assert.deepEqual(checkedFinSource({ ...first, repository: { branch: "main", url } }), first, "JSON key order does not change identity")
  assert.throws(() => checkedFinSource({ ...first, commit: "a".repeat(40) }), reason("digest"))
  for (const cwd of ["../outside", "/outside", "a/../b", "a\\b", "a\0b", "a//b"])
    assert.throws(() => sealFinSource({ ...first, cwd }))
  await run(repo, "checkout", "--detach", first.commit)
  const detached = await captureFinSource(git, repo)
  assert.equal(detached.repository.branch, undefined)
  await run(repo, "checkout", "main")
  await writeFile(join(repo, "untracked"), "not committed")
  await assert.rejects(captureFinSource(git, repo), reason("dirty")); await rm(join(repo, "untracked"))
  await run(repo, "update-index", "--assume-unchanged", "src/file")
  await assert.rejects(captureFinSource(git, repo), reason("unsupported"))
  await run(repo, "update-index", "--no-assume-unchanged", "src/file")

  await run(root, "clone", "--", remote, clone)
  await run(clone, "remote", "set-url", "origin", url)
  assert.equal(await verifyFinSource(git, clone, first), join(clone, "src"))
  await commit("second")
  await assert.rejects(captureFinSource(git, repo), reason("unpublished"))
  await run(repo, "push", "origin", "main")
  const second = await captureFinSource(git, join(repo, "src"))
  assert.notEqual(first.sha256, second.sha256)
  assert.equal(await verifyFinSource(git, clone, first), join(clone, "src"), "a moved remote branch cannot change the sealed input")
  await assert.rejects(verifyFinSource(git, clone, second), reason("checkout"))
  await run(clone, "config", `url.${remote}.insteadOf`, url)
  await run(clone, "fetch", "origin", "main")
  await run(clone, "checkout", "--detach", second.commit)
  await assert.rejects(verifyFinSource(git, clone, first), reason("checkout"), "a normal clone at the newer tip refuses the earlier input before a brief")
  await run(clone, "checkout", "--detach", first.commit)
  await run(clone, "remote", "set-url", "origin", "https://github.com/acme/other")
  await assert.rejects(verifyFinSource(git, clone, first), reason("checkout"))
  await run(clone, "remote", "set-url", "origin", url)
  await symlink(root, join(clone, "escape"))
  const escaped = sealFinSource({ ...first, cwd: "escape" })
  await assert.rejects(verifyFinSource(git, clone, escaped), reason("dirty"))
  // A configured carried/ignored directory still cannot escape the prepared root.
  await writeFile(join(clone, ".git/info/exclude"), "escape\n")
  await assert.rejects(verifyFinSource(git, clone, escaped), reason("cwd")); await rm(join(clone, "escape"))
  await assert.rejects(verifyFinSource(git, clone, sealFinSource({ ...first, cwd: "missing" })), reason("cwd"))
  await assert.rejects(verifyFinSource(git, clone, sealFinSource({ ...first, cwd: "src/file" })), reason("cwd"))

  const native = git.run.bind(git)
  const denied = mock.method(git, "run", async (options: Parameters<Git["run"]>[0]) => {
    if (options.args[0] === "ls-remote") throw new Error("PRIVATE-AUTH-OUTPUT")
    return native(options)
  })
  await assert.rejects(captureFinSource(git, repo), error => error instanceof FinSourceError && !String(error).includes("PRIVATE"))
  denied.mock.restore()
  const racing = mock.method(git, "run", async (options: Parameters<Git["run"]>[0]) => {
    const result = await native(options)
    if (options.args[0] === "ls-remote") await native({ cwd: repo, args: ["checkout", "--detach", first.commit] })
    return result
  })
  await assert.rejects(captureFinSource(git, repo), reason("changed"), "a HEAD move during publication inspection refuses the capture")
  racing.mock.restore(); await run(repo, "checkout", "main")
  const truncated = mock.method(git, "run", async (options: Parameters<Git["run"]>[0]) => {
    const result = await native(options)
    return { ...result, truncated: true }
  })
  await assert.rejects(verifyFinSource(git, clone, first), reason("unavailable"))
  truncated.mock.restore()

  let inspections = 0, changeAtFinal = false
  const world = new AgentsWorld({ root: join(root, "host"), verifySource: async (folder, source) => {
    if (++inspections === 2 && changeAtFinal) await run(clone, "checkout", "--detach", second.commit)
    return verifyFinSource(git, folder, source)
  }, script: () => "ok" })
  try {
    const apex = await world.apex("claude")
    assert.equal(apex.caller.kind, "agent")
    if (apex.caller.kind !== "agent") throw new Error("Fixture caller missing")
    const thread = world.store.journalPlacement(apex.conversation)!.thread
    const key = "committed", op = `start:${apex.caller.session}:${key}`
    const input: AgentsPlaceInput = { version: ORCHESTRATION_VERSION, op, clientKey: key, parent: { device: randomUUID(), thread, session: apex.caller.session, access: "auto" }, brief: { objective: "Use the exact committed source" }, name: "reader", harness: "codex", access: "auto", workspace: { folder: clone, source: first } }
    const wire = hostCallSchema("mako:agents-place").parse([input])[0]
    assert.deepEqual(wire.workspace.source, first, "normal generated host input retains the manifest")
    assert.equal(world.agents.capabilities().committedSource, 1)
    const calls: string[] = []
    let supported = false
    const sender = new AgentPlaces({ jobs: world.jobs, waiting: () => [], taken: () => {}, standing: () => ({ heard: 1, working: true, owner: 1, seq: 1 }), link: {
      self: async () => wire.parent.device, devices: async () => [], call: async (_target, channel): Promise<Json> => {
        calls.push(channel)
        return channel === "mako:agents-capabilities"
          ? { orchestration: { version: ORCHESTRATION_VERSION }, slots: { used: 0, of: 1 }, harnesses: ["codex"], ...(supported && { committedSource: 1 }) }
          : { child: randomUUID(), name: "reader", harness: "codex", access: "auto", state: "idle", sourceSha256: "0".repeat(64) }
      },
    } })
    try {
      const unsupported = await sender.place({ kind: "cloud", thread: "t-fixture" }, wire)
      assert.ok("refused" in unsupported && unsupported.refused === "unsupported")
      assert.deepEqual(calls, ["mako:agents-capabilities"], "an older host never receives a source it could silently strip")
      supported = true
      const unknown = await sender.place({ kind: "cloud", thread: "t-fixture" }, wire)
      assert.ok("lost" in unknown, "a mismatched receipt retains an unknown outcome under the existing op")
    } finally { sender.dispose() }
    const invalid = await world.agents.place({ ...wire, workspace: { folder: clone, source: { ...first, sha256: "0".repeat(64) } } })
    assert.ok("refused" in invalid)
    assert.equal(inspections, 0, "a malformed seal refuses before any checkout inspection")
    const finStarts = () => world.starts.filter(start => start.conversation !== apex.conversation).length
    const before = finStarts()
    await run(clone, "checkout", "--detach", second.commit)
    const wrong = await world.agents.place(wire)
    assert.ok("refused" in wrong)
    assert.equal(finStarts(), before, "no harness or brief starts for the wrong checkout")
    await run(clone, "checkout", "--detach", first.commit)
    const placed = await world.agents.place(wire)
    assert.ok(!("refused" in placed), JSON.stringify(placed))
    if ("refused" in placed) throw new Error("Fixture placement refused")
    assert.deepEqual(world.store.edges().of(placed.child)?.source, first, "source is kept atomically with the normal edge")
    assert.equal(placed.sourceSha256, first.sha256, "receipt is derived from the retained edge")
    const repeated = await world.agents.place(wire)
    assert.ok(!("refused" in repeated) && repeated.deduped && repeated.child === placed.child)
    const conflicting = await world.agents.place({ ...wire, workspace: { folder: clone, source: second } })
    assert.ok("refused" in conflicting && conflicting.refused === "conflict")
    await world.restart()
    const restored = await world.agents.place(wire)
    assert.ok(!("refused" in restored) && restored.child === placed.child && restored.deduped)
    assert.ok("refused" in await world.agents.place({ ...wire, workspace: { folder: clone, source: second } }), "conflicting input remains refused after restart")
    inspections = 0; changeAtFinal = true
    const late = { ...wire, op: `start:${wire.parent.session}:late`, clientKey: "late" }
    const changed = await world.agents.place(late)
    assert.ok("refused" in changed, "a checkout changed during admission never reaches the first brief")
    assert.equal(world.store.edges().byOp(late.op), undefined)
    changeAtFinal = false
    await run(clone, "checkout", "--detach", first.commit)
    const stopped = { ...wire, op: `start:${wire.parent.session}:stopped`, clientKey: "stopped" }
    await world.agents.cancel({ version: ORCHESTRATION_VERSION, op: stopped.op, parent: stopped.parent })
    const beforeStop = inspections
    assert.ok("refused" in await world.agents.place(stopped))
    assert.equal(inspections, beforeStop, "a cancelled start never acquires source readiness")
  } finally { await world.close() }
  const old = new AgentsWorld({ root: join(root, "unsupported"), script: () => "ok" })
  try { assert.equal(old.agents.capabilities().committedSource, undefined, "hosts without the source gate advertise no support") }
  finally { await old.close() }
  console.log("Committed Fin source: actual Git publication, pinning, confinement, bounded refusals and normal placement/receipt/restart gates passed")
} finally {
  mock.restoreAll()
  await git.close()
  await rm(root, { recursive: true, force: true })
}
