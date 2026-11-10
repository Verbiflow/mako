import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import { keepHostLog, openHostLog } from "@mako/host/base/host-log"
import { ThreadMoveTool, type HostMoves } from "@mako/host/conversations/thread-move-tool"
import { CloudMoves, type CloudMovesOptions } from "@mako/host/conversations/cloud-moves"
import * as diagnostics from "@mako/host/conversations/move-diagnostics"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import type { ThreadMoveOutcome, ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"

// Only owned scratch files and synthetic move dependencies; no account, provider, checkout or release is changed.
const root = await mkdtemp(join(tmpdir(), "mako-move-diagnostics-"))
const path = join(root, "host.log")
const log = openHostLog(path)
const stop = keepHostLog(log)
let failures = 0
const cases: Array<{ name: string; passed: boolean }> = []
const conversation = "58424503-2966-4d99-b32a-dc85e6ddf3dd"
const originalReason = "This folder holds no repository, so there's no branch to make."
const sensitive = "ghp_SYNTHETIC_TOKEN_12345678901234567890 https://user:password@example.invalid/repo?token=PRIVATE_QUERY /Users/fixture-privacy/PRIVATE_PATH 'PRIVATE_PROMPT' UNQUOTED_USER_CONTENT"

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); cases.push({ name, passed: true }) }
  catch { failures++; cases.push({ name, passed: false }) }
}

async function runTool(key: string, action: HostMoves["move"], handsOff = false) {
  let busy = true
  let calls = 0
  let complete!: () => void
  const done = new Promise<void>((resolve) => { complete = resolve })
  const invoked: Array<{ conversation: string; move: string }> = []
  const tool = new ThreadMoveTool({
    conversationOf: () => conversation,
    place: () => "here",
    tier: () => "full",
    busy: () => busy,
    ownWorktree: () => handsOff,
    machine: false,
    handOffAfterMs: 0,
    gate: new AgentAskGate({ open: () => [], raise: () => { throw new Error("unexpected approval") }, settle: () => undefined }),
    moves: () => ({
      move(id, move, handOff) {
        calls++
        invoked.push({ conversation: id, move })
        try { return Promise.resolve(action(id, move, handOff)).finally(complete) }
        catch (error) { complete(); throw error }
      },
      refusal: async () => undefined,
      bringBack: async () => { throw new Error("unexpected return") },
      continue: async () => { throw new Error("unexpected continue") },
    }),
  })
  const answer = await tool.move({ kind: "agent", session: "synthetic-session" }, { to: "cloud", clientKey: key })
  assert.ok("move" in answer)
  assert.equal(answer.outcome, handsOff ? "handing-off" : "after-turn", "acceptance remains pending, not cloud-ready")
  assert.equal(calls, 0)
  if (!handsOff) assert.equal(tool.pending(conversation), true)
  busy = false
  let dispatchError: unknown
  try { tool.settled(conversation); tool.settled(conversation) } catch (error) { dispatchError = error }
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic move did not finish")), 2_000) })]) }
  finally { clearTimeout(timer) }
  await tick()
  await log.flush()
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.includes(`move=${answer.move}`))
  assert.equal(calls, 1, "settled notifications never invoke the action twice")
  assert.deepEqual(invoked, [{ conversation, move: answer.move }])
  assert.equal(tool.pending(conversation), false)
  return { answer, lines, dispatchError }
}

function cloud(label: string, kind: "plan" | "own-branch" | "fork", failure?: { error: unknown }) {
  const folder = join(root, label, "moves")
  const counts = { ownBranch: 0, release: 0, remote: 0 }
  const steps: Array<{ conversation: string; move: string; step: ThreadMoveStep }> = []
  const thread = ThreadIdSchema.parse("77777777-7777-4777-8777-777777777777")
  const session = SessionIdSchema.parse("88888888-8888-4888-8888-888888888888")
  const account: Pick<NonNullable<ReturnType<CloudMovesOptions["account"]>>, "id"> = { id: async () => "synthetic-account" }
  const git: Pick<CloudMovesOptions["git"], "succeeds"> = { succeeds: async () => false }
  const later = () => { counts.remote++; throw new Error("unexpected later move dependency") }
  const options: CloudMovesOptions = {
    folder,
    // SAFETY: Early planning reads only account.id. Any later move dependency is forbidden below.
    account: () => kind === "plan" ? undefined : account as NonNullable<ReturnType<CloudMovesOptions["account"]>>,
    threads: () => ({
      journalPlacement: () => ({ thread, session }),
      threadSessions: () => [{ session, journals: [conversation], natives: [] }],
      execution: () => undefined,
      moveStatus: () => undefined,
      person: later,
    }),
    checkout: () => undefined,
    snapshot: (id: string) => ({ session: { nativeId: id === conversation ? "native" : undefined, nativePath: join(root, "synthetic-session"), harness: "codex", cwd: root, currentMode: null } }),
    remembered: () => undefined,
    // SAFETY: Early planning uses only git.succeeds; no Git command or later checkout operation may run.
    git: git as CloudMovesOptions["git"],
    ownBranch: async () => {
      counts.ownBranch++
      if (kind === "fork") return "synthetic-fork"
      if (failure) throw failure.error
      throw Object.assign(new Error(`Git couldn't create the worktree: ${sensitive}`), { code: "EACCES" })
    },
    moves: { settledBlockers: async () => [], begin: later, cancel: later, confirm: later, reclaim: later, release: async () => { counts.release++; throw new Error("unexpected release") } },
    repositoryOf: async () => later(),
    sendRecords: async () => later(),
    cloud: { adopt: async () => later(), callThread: async () => later() },
    live: { handOff: async () => later(), continueTurn: later, waitingPrompts: later, carried: later },
    newCloudThread: () => { counts.remote++; throw new Error("unexpected cloud creation") },
    step: (id: string, move: string, step: ThreadMoveStep) => { steps.push({ conversation: id, move, step }) },
  }
  return { moves: new CloudMoves(options), folder, counts, steps }
}

try {
  for (const field of ["message", "code"] as const) await check(`helper never invokes a ${field} accessor`, async () => {
    let reads = 0
    const error = new Error(originalReason)
    Object.defineProperty(error, field, { enumerable: false, get() { reads++; throw new Error("ACCESSOR_MUST_NOT_RUN") } })
    const result = diagnostics.moveDiagnosticReason({ error })
    assert.equal(reads, 0)
    assert.deepEqual(result, { reason: "The move failed; its private error details were withheld.", reasonRedacted: true })
  })
  for (const [label, value] of [["number", 23], ["null", null], ["object", { toString() { throw new Error("NO_COERCION") } }]] as const) await check(`helper withholds nonstring message ${label}`, async () => {
    const error = Object.defineProperty(new Error(), "message", { value })
    assert.deepEqual(diagnostics.moveDiagnosticReason({ error }), { reason: "The move failed; its private error details were withheld.", reasonRedacted: true })
  })
  await check("descriptor traps, revoked proxies and unknown shapes fail closed without coercion", async () => {
    let traps = 0
    let prototypes = 0
    let coerced = 0
    const proxy = new Proxy({}, {
      getPrototypeOf() { prototypes++; throw new Error("NO_PROTOTYPE_INSPECTION") },
      getOwnPropertyDescriptor() { traps++; throw new Error("PRIVATE_DESCRIPTOR_FAILURE") },
    })
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    for (const value of [proxy, revoked.proxy, null, undefined, Symbol("PRIVATE_SYMBOL"), { message: sensitive, toString() { coerced++; throw new Error("NO_COERCION") } }]) {
      assert.deepEqual(diagnostics.moveDiagnosticReason({ error: value }), { reason: "The move failed; its private error details were withheld.", reasonRedacted: true })
    }
    assert.ok(traps <= 1, "inspection is bounded")
    assert.equal(prototypes, 0)
    assert.equal(coerced, 0)
  })
  await check("diagnostic writer failure is attempted once and cannot replace the caller result", async () => {
    const result = { kind: "kept-here", reason: originalReason }
    let writes = 0
    const complete = () => {
      diagnostics.logMoveDiagnostic(() => { writes++; throw new Error("PRIVATE_LOGGER_FAILURE") })
      return result
    }
    assert.equal(complete(), result)
    assert.equal(writes, 1)
  })
  await check("reviewer nonenumerable code getter preserves actual CloudMoves outcome, step and identity", async () => {
    let reads = 0
    const error = new Error(originalReason)
    Object.defineProperty(error, "code", { enumerable: false, get() { reads++; throw new Error("CODE_ACCESS_THROW") } })
    const current = cloud("reviewer-code-getter", "own-branch", { error })
    const move = "22222222-2222-4222-8222-222222222222"
    const outcome = await current.moves.move(conversation, move)
    await log.flush()
    assert.deepEqual(outcome, { kind: "kept-here", reason: originalReason })
    assert.deepEqual(current.steps.at(-1), { conversation, move, step: { kind: "kept-here", reason: originalReason } })
    assert.equal(reads, 0)
    assert.deepEqual(current.counts, { ownBranch: 1, release: 0, remote: 0 })
    const line = (await readFile(path, "utf8")).split("\n").find((line) => line.includes(`move=${move}`) && line.includes("before its plan was saved"))
    assert.ok(line?.includes(`conversation=${conversation}`) && line.includes("stage=own-branch") && line.includes("reasonRedacted=true"))
  })
  for (const [name, error, reason] of [
    ["nonstring", Object.defineProperty(new Error(), "message", { value: 23 }), 23],
    ["null", null, "null"],
  ] as const) await check(`actual CloudMoves preserves existing ${name} outcome without a diagnostic exception`, async () => {
    const current = cloud(`actual-${name}`, "own-branch", { error })
    assert.deepEqual(await current.moves.move(conversation, "33333333-3333-4333-8333-333333333333"), { kind: "kept-here", reason })
    assert.deepEqual(current.counts, { ownBranch: 1, release: 0, remote: 0 })
    // Existing errorMessage behavior is retained; this diagnostic patch does not redefine the wire's error contract.
  })
  await check("an original message-getter exception retains its exact error identity", async () => {
    const original = new Error("ORIGINAL_MESSAGE_GETTER_ERROR")
    const error = Object.defineProperty(new Error(), "message", { get() { throw original } })
    const current = cloud("original-message-error", "own-branch", { error })
    await assert.rejects(current.moves.move(conversation, "44444444-4444-4444-8444-444444444444"), (error) => error === original)
    assert.deepEqual(current.counts, { ownBranch: 1, release: 0, remote: 0 })
  })
  await check("an original descriptor-trap exception retains its exact error identity", async () => {
    const original = new Error("ORIGINAL_DESCRIPTOR_TRAP_ERROR")
    const error = new Proxy(new Error(originalReason), { getOwnPropertyDescriptor() { throw original } })
    const current = cloud("original-descriptor-error", "own-branch", { error })
    await assert.rejects(current.moves.move(conversation, "66666666-6666-4666-8666-666666666666"), (error) => error === original)
    assert.deepEqual(current.counts, { ownBranch: 1, release: 0, remote: 0 })
  })
  await check("an actual durable writer filesystem fault leaves CloudMoves result and one invocation intact", async () => {
    const notDirectory = join(root, "not-a-directory")
    await writeFile(notDirectory, "owned scratch obstruction")
    const broken = openHostLog(join(notDirectory, "host.log"))
    const detach = keepHostLog(broken)
    try {
      const current = cloud("logger-filesystem-fault", "own-branch", { error: new Error(originalReason) })
      assert.deepEqual(await current.moves.move(conversation, "55555555-5555-4555-8555-555555555555"), { kind: "kept-here", reason: originalReason })
      await broken.flush()
      assert.deepEqual(current.counts, { ownBranch: 1, release: 0, remote: 0 })
    } finally { detach() }
  })
  await check("ThreadMoveTool records a null rejection once without coercing the thrown value", async () => {
    const result = await runTool("throw-null", () => Promise.reject(null))
    assert.equal(result.dispatchError, undefined)
    const terminal = result.lines.filter((line) => line.includes("an agent's move failed"))
    assert.equal(terminal.length, 1)
    assert.ok(terminal[0]?.includes("reasonRedacted=true") && terminal[0].includes("stage=move-call"))
  })
  await check("resolved refusal retains the exact bounded product reason and identity", async () => {
    const result = await runTool("resolved", async () => ({ kind: "kept-here", reason: originalReason }))
    assert.equal(result.dispatchError, undefined)
    const terminal = result.lines.filter((line) => line.includes("an agent's move ended"))
    assert.equal(terminal.length, 1)
    assert.ok(terminal[0]?.includes(`conversation=${conversation}`) && terminal[0].includes("stage=move-result") && terminal[0].includes(originalReason))
    assert.ok(terminal[0]?.includes("reasonRedacted=false"))
  })
  await check("an unrecognized resolved reason is withheld rather than logging user content", async () => {
    const result = await runTool("private-resolved", async () => ({ kind: "kept-here", reason: sensitive.repeat(40) }))
    const terminal = result.lines.filter((line) => line.includes("an agent's move ended"))
    assert.equal(terminal.length, 1)
    assert.ok(terminal[0]?.includes("reasonRedacted=true") && terminal[0].includes("stage=move-result"))
    assert.ok(terminal[0]!.length < 600)
    for (const privatePart of ["ghp_", "https:", "PRIVATE_", "/Users/", "UNQUOTED_USER_CONTENT"]) assert.ok(!terminal[0]!.includes(privatePart))
  })
  for (const mode of ["reject", "throw"] as const) await check(`${mode} is logged once without leaking private error text`, async () => {
    const failure = Object.assign(new Error(sensitive.repeat(40)), { code: "EACCES" })
    const action = (): Promise<ThreadMoveOutcome> => { if (mode === "throw") throw failure; return Promise.reject(failure) }
    const result = await runTool(mode, action)
    assert.equal(result.dispatchError, undefined)
    const terminal = result.lines.filter((line) => line.includes("an agent's move failed"))
    assert.equal(terminal.length, 1)
    assert.ok(terminal[0]?.includes(`conversation=${conversation}`) && terminal[0].includes("stage=move-call") && terminal[0].includes("code=EACCES"))
    assert.ok(terminal[0]?.includes("reasonRedacted=true"))
    assert.ok(terminal[0]!.length < 600)
    for (const privatePart of ["ghp_", "https:", "PRIVATE_", "/Users/", "UNQUOTED_USER_CONTENT"]) assert.ok(!terminal[0]!.includes(privatePart))
  })
  for (const kind of ["plan", "own-branch", "fork"] as const) await check(`actual CloudMoves ${kind} refusal reaches the existing durable log before any plan/release`, async () => {
    const current = cloud(kind, kind)
    const result = await runTool(kind, (id, move, handOff) => current.moves.move(id, move, handOff))
    const diagnostic = result.lines.filter((line) => line.includes("before its plan was saved"))
    assert.equal(diagnostic.length, 1)
    assert.ok(diagnostic[0]?.includes(`conversation=${conversation}`))
    assert.ok(diagnostic[0]?.includes(`stage=${kind === "plan" ? "plan" : "own-branch"}`))
    if (kind === "plan") assert.ok(diagnostic[0]?.includes("Moving to the cloud needs this Mac signed in to Mako Cloud."))
    if (kind === "own-branch") {
      assert.ok(diagnostic[0]?.includes("Git couldn't create the worktree.") && diagnostic[0].includes("code=EACCES"))
      for (const privatePart of ["ghp_", "https:", "PRIVATE_", "/Users/", "UNQUOTED_USER_CONTENT"]) assert.ok(!result.lines.join("\n").includes(privatePart))
    }
    if (kind === "fork") assert.ok(diagnostic[0]?.includes("currentConversation=synthetic-fork") && diagnostic[0].includes("Send it one, then move it to the cloud."))
    assert.deepEqual(current.counts, { ownBranch: kind === "plan" ? 0 : 1, release: 0, remote: 0 })
    assert.deepEqual(await readdir(current.folder).catch(() => []), [], "early diagnostics do not invent a move plan")
  })
  for (const handsOff of [false, true]) await check(`normal ${handsOff ? "handing-off" : "after-turn"} acceptance and terminal outcome stay unchanged`, async () => {
    const result = await runTool(`normal-${handsOff}`, async () => ({ kind: "moved", cloudThread: "synthetic-cloud" }), handsOff)
    assert.equal(result.dispatchError, undefined)
    const terminal = result.lines.filter((line) => line.includes("an agent's move ended"))
    assert.equal(terminal.length, 1)
    assert.ok(terminal[0]?.includes("outcome=moved") && !terminal[0].includes("reason="))
  })
} finally {
  stop()
  await log.flush()
  await rm(root, { recursive: true, force: true })
}
for (const result of cases) console.log(`${result.passed ? "PASS" : "FAIL"}: ${result.name}`)
assert.equal(failures, 0, `${failures} move diagnostic controls failed`)
