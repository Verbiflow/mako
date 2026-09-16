import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startConversationMcp } from "../electron/conversation-mcp.ts"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { LiveJournal } from "../electron/live-journal.ts"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import { SessionMemory } from "../electron/session-memory.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type {
  LiveSessionState,
  HostEvent,
  TransferInput,
} from "../electron/shared.ts"

const root = mkdtempSync(join(tmpdir(), "mako-transfers-"))
const livePids = new Set([41, 42])
const memoryPath = join(root, "session-memory.sqlite")
const memory = new SessionMemory(
  memoryPath,
  { pid: 41, startedAt: 1, label: "transfer host" },
  { now: () => Date.now(), alive: (pid) => livePids.has(pid) }
)
const observerMemory = new SessionMemory(
  memoryPath,
  { pid: 42, startedAt: 2, label: "observer host" },
  { now: () => Date.now(), alive: (pid) => livePids.has(pid) }
)
const sessions = new Map<string, LiveSessionState>()
interface Dispatch {
  id: string
  text: string
  attachments: Parameters<ProviderLiveDriver["prompt"]>[2]
}
const sent: Dispatch[] = []
const opened: string[] = []
const openedModes: Array<string | undefined> = []
const closed: string[] = []
const events: HostEvent[] = []
const emitters = new Map<
  string,
  Array<NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]>>
>()
let failDestination = false
let releaseSlow = false
let slowStarted = false
let closeBlockedFor: string | null = null
let blockedCloseStarted = false
let releaseBlockedClose: (() => void) | undefined
function driver(provider: string): ProviderLiveDriver {
  return {
    provider,
    canResume: true,
    available: () => true,
    async start(cwd, options) {
      if (provider === "slow") {
        slowStarted = true
        await until(() => releaseSlow)
      }
      if (provider === "broken" && failDestination)
        throw new Error("Destination startup refused")
      const session: LiveSessionState = {
        id: options.conversationId,
        nativeId: `native-${options.conversationId}`,
        harness: provider,
        cwd,
        status: "ready",
        connection: "connected",
        modes: [{ id: "plan", name: "Plan" }],
        currentMode: options.modeId ?? null,
        configOptions: [],
      }
      if (options.emit) {
        const history = emitters.get(options.conversationId) ?? []
        history.push(options.emit)
        emitters.set(options.conversationId, history)
      }
      opened.push(session.id)
      openedModes.push(options.modeId)
      sessions.set(session.id, session)
      return session
    },
    async prompt(id, text, attachments) {
      sent.push({ id, text, attachments })
      const session = sessions.get(id)
      assert.ok(session)
      const running = { ...session, status: "running" as const }
      sessions.set(id, running)
      emitters.get(id)?.at(-1)?.({
        type: "live-session",
        session: running,
      })
    },
    async cancel() {},
    async permission() {},
    async setMode() {},
    async close(id) {
      closed.push(id)
      if (provider === closeBlockedFor) {
        blockedCloseStarted = true
        await new Promise<void>((resolve) => {
          releaseBlockedClose = resolve
        })
      }
    },
  }
}
const drivers = new Map(
  ["alpha", "beta", "broken", "slow"].map((provider) => [
    provider,
    driver(provider),
  ])
)
function createOwner() {
  return new LiveConversations({
    root,
    appPath: root,
    driver: (provider) => drivers.get(provider),
    history: async () => {
      throw new Error(
        "Transfers must use captured history, not lagging native files"
      )
    },
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    memory,
    emit: (event) => events.push(event),
  })
}
let owner = createOwner()
let mcp: Awaited<ReturnType<typeof startConversationMcp>> | null = null
let mcpClient: Client | null = null
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for transfer state")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
function finish(id: string, text: string) {
  const session = sessions.get(id)
  assert.ok(session)
  emitters.get(id)?.at(-1)?.({
    type: "live-update",
    id,
    update: { kind: "text", text },
  })
  const ready = { ...session, status: "ready" as const, lastStop: "end_turn" }
  sessions.set(id, ready)
  emitters.get(id)?.at(-1)?.({ type: "live-session", session: ready })
}
function command(provider: string, text: string): TransferInput {
  return { id: randomUUID(), provider, text, attachments: [] }
}
try {
  const id = randomUUID()
  await owner.start("alpha", root, { conversationId: id })
  await until(() => owner.snapshot(id)?.session.status === "ready")
  owner.submit(id, randomUUID(), "Original task")
  finish(id, "Original answer with the decision: keep the parser")
  const request = command("beta", "Review the implementation")
  request.modeId = "plan"
  request.attachments.push({
    name: "plot.png",
    mimeType: "image/png",
    size: 3,
    data: "YWJj",
  })
  owner.transfer(id, request)
  owner.transfer(id, request)
  await until(() => sent.length === 2)
  assert.equal(
    opened.length,
    2,
    "same transfer ID creates only one destination"
  )
  assert.equal(
    openedModes[1],
    "plan",
    "the destination's selected access mode applies at process launch"
  )
  const beta = sent[1]!
  assert.notEqual(
    beta.id,
    id,
    "provider connection identity differs from app identity"
  )
  assert.equal(owner.snapshot(id)?.session.id, id)
  assert.equal(beta.attachments[0]?.data, request.attachments[0]?.data)
  assert.equal(
    readFileSync(beta.attachments[0]!.path!).toString("base64"),
    request.attachments[0]?.data
  )
  assert.match(beta.text, /Current request:\nReview the implementation/)
  const firstTransfer = owner.snapshot(id)?.control?.transfers[0]
  assert.equal(firstTransfer?.state.kind, "accepted")
  if (firstTransfer?.state.kind !== "accepted")
    throw new Error("Missing manifest")
  assert.match(
    readFileSync(firstTransfer.state.manifest.file, "utf8"),
    /keep the parser/
  )
  finish(beta.id, "Review found a missing attachment test")
  assert.equal(
    observerMemory.heldBy("alpha", `native-${id}`),
    null,
    "an accepted transfer releases the retired source hold"
  )
  assert.equal(
    observerMemory.heldBy("beta", `native-${beta.id}`)?.conversationId,
    id,
    "an accepted transfer holds the active destination"
  )

  // Late provider events from the dormant connection must not complete beta's run.
  const beforeLate = owner.snapshot(id)
  owner.observe({
    type: "live-update",
    id,
    update: { kind: "text", text: "stale alpha output" },
  })
  assert.deepEqual(owner.snapshot(id), beforeLate)
  const back = command("alpha", "Apply the review")
  owner.transfer(id, back)
  await until(() => sent.length === 3)
  assert.equal(
    opened.length,
    3,
    "returning to alpha resumes its native session without retaining its process"
  )
  assert.equal(sent[2]?.id, id)
  const secondTransfer = owner.snapshot(id)?.control?.transfers[1]
  if (secondTransfer?.state.kind !== "accepted")
    throw new Error("Missing delta manifest")
  const delta = readFileSync(secondTransfer.state.manifest.file, "utf8")
  assert.match(delta, /missing attachment test/)
  assert.doesNotMatch(delta, /Original answer with the decision/)
  assert.ok(secondTransfer.state.manifest.fromBlock > 0)
  assert.deepEqual(
    closed,
    [id, beta.id],
    "each accepted switch retires the now-dormant provider process"
  )
  assert.equal(
    observerMemory.heldBy("beta", `native-${beta.id}`),
    null,
    "returning to alpha releases beta's hold"
  )
  assert.equal(
    observerMemory.heldBy("alpha", `native-${id}`)?.conversationId,
    id,
    "returning to alpha reacquires its hold"
  )
  const beforeRetiredEvent = owner.snapshot(id)
  emitters.get(id)?.at(0)?.({
    type: "live-session",
    session: {
      ...sessions.get(id)!,
      status: "closed",
      connection: "disconnected",
    },
  })
  assert.deepEqual(
    owner.snapshot(id),
    beforeRetiredEvent,
    "an event from alpha's retired incarnation cannot affect resumed alpha"
  )

  // A busy switch waits for the authoritative root terminal event.
  const busy = command("beta", "Check the fix")
  owner.transfer(id, busy)
  assert.equal(sent.length, 3)
  assert.throws(
    () => owner.submit(id, randomUUID(), "racing message"),
    /switch is pending/
  )
  finish(id, "Fix applied")
  await until(() => sent.length === 4)
  finish(beta.id, "Fix verified")

  const closedBeforeFailure = closed.length
  failDestination = true
  const failed = command("broken", "Try another provider")
  owner.transfer(id, failed)
  await until(
    () => owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind === "failed"
  )
  assert.equal(owner.snapshot(id)?.session.harness, "beta")
  assert.equal(owner.snapshot(id)?.session.status, "ready")
  assert.equal(
    closed.length,
    closedBeforeFailure,
    "a failed destination does not close the active source"
  )
  owner.submit(id, randomUUID(), "The source still works")
  assert.equal(sent.at(-1)?.id, beta.id)
  finish(beta.id, "Still connected")
  assert.throws(
    () => owner.transfer(id, { ...failed, text: "different" }),
    /different content/
  )

  const firstRequest = owner.snapshot(id)?.requests[0]
  assert.ok(firstRequest)
  const forkId = randomUUID()
  const forkInput = {
    id: forkId,
    provider: "alpha",
    point: { kind: "run" as const, requestId: firstRequest.id },
  }
  const beforeFork = opened.length
  const fork = owner.fork(id, forkInput)
  assert.equal(
    opened.length,
    beforeFork,
    "an idle fork spends no provider startup or prompt"
  )
  assert.match(JSON.stringify(fork.base?.entries), /keep the parser/)
  assert.doesNotMatch(
    JSON.stringify(fork.base?.entries),
    /missing attachment test/
  )
  assert.equal(owner.fork(id, forkInput).session.id, forkId)
  assert.throws(
    () => owner.fork(id, { ...forkInput, provider: "beta" }),
    /another source point/
  )
  assert.equal(fork.control?.ancestry?.parentId, id)
  owner.submit(forkId, randomUUID(), "Explore this branch")
  await until(() => owner.snapshot(forkId)?.session.status === "running")
  const forkBinding = owner.snapshot(forkId)?.control?.activeBindingId
  assert.ok(forkBinding)
  finish(forkBinding, "Fork findings")
  assert.equal(
    owner
      .snapshot(id)
      ?.blocks.some(
        (block) => block.type === "text" && block.text === "Fork findings"
      ),
    false
  )

  const mergeId = randomUUID()
  const beforeMerge = sent.length
  await owner.mergeFork(forkId, mergeId)
  await owner.mergeFork(forkId, mergeId)
  assert.equal(
    sent.length,
    beforeMerge,
    "merge-back waits for the next parent turn"
  )
  assert.equal(owner.snapshot(id)?.control?.merges.length, 1)
  owner.submit(id, randomUUID(), "Parent continues while child works")
  assert.match(sent.at(-1)?.text ?? "", /Context|context/)
  assert.equal(owner.snapshot(id)?.control?.merges[0]?.status, "consumed")
  const mergeContext = owner.snapshot(id)?.requests.at(-1)?.context?.[0]
  assert.ok(mergeContext)
  assert.match(readFileSync(mergeContext.file, "utf8"), /Fork findings/)
  assert.doesNotMatch(
    readFileSync(mergeContext.file, "utf8"),
    /Original answer with the decision/
  )
  const childInput = {
    id: randomUUID(),
    provider: "alpha",
    task: "Inspect just the parser boundary",
  }
  mcp = await startConversationMcp(owner)
  const credential = mcp.mint(beta.id, id)
  const unauthenticated = await fetch(credential.url, {
    method: "POST",
    body: "{}",
  })
  assert.equal(unauthenticated.status, 401)
  const revokedCredential = mcp.mint(beta.id, id)
  mcp.revoke(beta.id, id)
  const revoked = await fetch(revokedCredential.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${revokedCredential.token}` },
    body: "{}",
  })
  assert.equal(revoked.status, 401)
  const activeCredential = mcp.mint(beta.id, id)
  mcpClient = new Client({ name: "mako-transfer-test", version: "1.0.0" })
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(activeCredential.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${activeCredential.token}` },
      },
    })
  )
  const listed = await mcpClient.listTools()
  assert.ok(listed.tools.some((tool) => tool.name === "mako_delegate_task"))
  const parentRunning = sessions.get(beta.id)!
  owner.observe({
    type: "live-session",
    session: { ...parentRunning, currentMode: "restricted" },
  })
  const refused = await mcpClient.callTool({
    name: "mako_delegate_task",
    arguments: childInput,
  })
  assert.equal(
    refused.isError,
    true,
    "provider-specific restrictions cannot silently expand through delegation"
  )
  assert.equal(owner.snapshot(childInput.id), null)
  owner.observe({
    type: "live-session",
    session: { ...parentRunning, currentMode: null },
  })
  assert.throws(() => owner.authorizeAgent(id, randomUUID()), /no longer owns/)
  const delegated = await mcpClient.callTool({
    name: "mako_delegate_task",
    arguments: childInput,
  })
  assert.equal(delegated.isError, undefined, JSON.stringify(delegated))
  assert.equal(JSON.stringify(delegated).includes(activeCredential.token), false)
  assert.equal(
    JSON.stringify(owner.snapshot(id)).includes(activeCredential.token),
    false
  )
  await assert.rejects(
    owner.delegate(id, { ...childInput, id }),
    /another conversation/
  )
  assert.equal(owner.snapshot(id)?.session.id, id)
  await owner.delegate(id, childInput)
  await until(() => owner.snapshot(childInput.id)?.session.status === "running")
  assert.equal(
    sent.filter((dispatch) => dispatch.id === childInput.id).length,
    1
  )
  assert.equal(
    sent.at(-1)?.text,
    childInput.task,
    "delegation gives only the explicit task, not hidden parent history"
  )
  owner.observe({
    type: "live-permission",
    request: {
      id: "child-permission",
      sessionId: childInput.id,
      title: "May I read the fixture?",
      options: [],
    },
  })
  assert.equal(
    owner.snapshot(id)?.control?.children[0]?.status,
    "needs-permission"
  )
  assert.equal(owner.snapshot(id)?.control?.children[0]?.delivery, "pending")
  const sentBeforeChild = sent.length
  finish(childInput.id, "Child found the missing guard")
  await until(
    () => owner.snapshot(id)?.control?.children[0]?.delivery === "queued"
  )
  assert.equal(
    sent.length,
    sentBeforeChild,
    "child result waits behind the active parent run"
  )
  assert.equal(
    owner.snapshot(id)?.session.status,
    "running",
    "child terminal cannot complete parent"
  )
  finish(beta.id, "Parent work completed")
  await until(() => sent.length === sentBeforeChild + 1)
  assert.match(sent.at(-1)?.text ?? "", /Use the child's result/)
  assert.equal(owner.snapshot(id)?.control?.children[0]?.delivery, "delivered")
  finish(beta.id, "Incorporated the child result")
  const canceled = {
    id: randomUUID(),
    provider: "alpha",
    task: "Canceled task",
  }
  await owner.delegate(id, canceled)
  await until(() => owner.snapshot(canceled.id)?.session.status === "running")
  owner.cancelChild(id, canceled.id)
  finish(canceled.id, "Late canceled child output")
  assert.equal(
    owner
      .snapshot(id)
      ?.control?.children.find((child) => child.id === canceled.id)?.delivery,
    "dismissed"
  )
  assert.throws(() => owner.cancelChild(id, randomUUID()), /not a child/)

  // A failed activation write must neither dispatch nor replace the working source.
  const durableFailure = command(
    "alpha",
    "Cannot run without a durable activation"
  )
  const commit = LiveJournal.prototype.commit
  const failedWrite = mock.method(
    LiveJournal.prototype,
    "commit",
    function (next, previous) {
      if (
        next.control?.transfers.some(
          (transfer) =>
            transfer.input.id === durableFailure.id &&
            transfer.state.kind === "accepted"
        )
      )
        throw new Error("Injected activation write failure")
      return commit.call(this, next, previous)
    }
  )
  const beforeFailedWrite = sent.length
  owner.transfer(id, durableFailure)
  await until(
    () => owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind === "failed"
  )
  failedWrite.mock.restore()
  assert.equal(sent.length, beforeFailedWrite)
  assert.equal(owner.snapshot(id)?.session.harness, "beta")
  owner.submit(
    id,
    randomUUID(),
    "Source remains usable after failed journal write"
  )
  finish(beta.id, "Still usable")

  // A disconnected binding with a valid resume verdict continues through its
  // native session; Mako does not replay that session's own transcript into it.
  const dormant = sessions.get(id)!
  owner.observe({
    type: "live-session",
    session: { ...dormant, connection: "disconnected", status: "failed" },
  })
  const disconnectedReturn = command(
    "alpha",
    "Reconnect using captured history"
  )
  const beforeReconnect = opened.length
  owner.transfer(id, disconnectedReturn)
  await until(
    () => sent.at(-1)?.text.includes(disconnectedReturn.text) === true
  )
  assert.equal(opened.length, beforeReconnect + 1)
  const reconnectTransfer = owner.snapshot(id)?.control?.transfers.at(-1)
  assert.equal(reconnectTransfer?.state.kind, "accepted")
  if (reconnectTransfer?.state.kind === "accepted") {
    assert.ok(reconnectTransfer.state.manifest.fromBlock > 0)
    assert.equal(reconnectTransfer.state.manifest.includesBase, false)
    finish(reconnectTransfer.state.bindingId, "Reconnected")
  }
  const closingId = randomUUID()
  await owner.start("alpha", root, { conversationId: closingId })
  owner.transfer(closingId, command("slow", "Must never dispatch after close"))
  await until(() => slowStarted)
  owner.close(closingId)
  const beforeRelease = sent.length
  releaseSlow = true
  await until(() =>
    closed.some((connection) => sessions.get(connection)?.harness === "slow")
  )
  assert.equal(sent.length, beforeRelease)
  const retirementId = randomUUID()
  await owner.start("alpha", root, { conversationId: retirementId })
  owner.submit(retirementId, randomUUID(), "Seed retirement race")
  await until(() =>
    sent.some((entry) => entry.text === "Seed retirement race")
  )
  finish(retirementId, "Seeded")
  await until(
    () =>
      owner
        .snapshot(retirementId)
        ?.requests.every((request) => request.status === "completed") ??
      false
  )
  closeBlockedFor = "alpha"
  const supersededTransfer = command(
    "beta",
    "Must not dispatch after close during source retirement"
  )
  owner.transfer(retirementId, supersededTransfer)
  await until(() => blockedCloseStarted)
  const closeDuringRetirement = owner.close(retirementId)
  releaseBlockedClose?.()
  await closeDuringRetirement
  closeBlockedFor = null
  await until(
    () => owner.snapshot(retirementId)?.session.status === "closed"
  )
  assert.equal(
    sent.some((entry) => entry.text.includes(supersededTransfer.text)),
    false,
    "close during source retirement cannot resurrect and dispatch a transfer"
  )
  const idleForkId = randomUUID()
  owner.fork(id, { ...forkInput, id: idleForkId })
  const interruptedChild = {
    id: randomUUID(),
    provider: "beta",
    task: "Interrupted child fixture",
  }
  await owner.delegate(id, interruptedChild)
  await until(
    () => owner.snapshot(interruptedChild.id)?.session.status === "running"
  )
  const count = sent.length
  owner.stop()
  owner = createOwner()
  assert.equal(owner.snapshot(closingId)?.session.status, "closed")
  assert.equal(owner.snapshot(idleForkId)?.session.status, "ready")
  const recovered = owner.snapshot(id)
  assert.equal(recovered?.session.connection, "disconnected")
  assert.equal(
    recovered?.control?.children.find(
      (child) => child.id === interruptedChild.id
    )?.status,
    "failed"
  )
  await owner.delegate(id, interruptedChild)
  assert.equal(
    sent.length,
    count,
    "recovered child intent never replays execution"
  )
  assert.deepEqual(
    recovered?.control?.bindings.map((binding) => binding.provider).sort(),
    ["alpha", "beta"],
    "native resume reuses provider provenance instead of adding a duplicate binding"
  )
  owner.transfer(id, request)
  assert.equal(
    sent.length,
    count,
    "recovery of accepted receipt never repeats provider execution"
  )
  assert.ok(
    events.some((event) => event.type === "live-batch" && event.batch.control)
  )
  const retainedId = randomUUID()
  await owner.start("alpha", root, { conversationId: retainedId })
  await until(() => owner.snapshot(retainedId)?.session.status === "ready")
  owner.submit(retainedId, randomUUID(), "Busy attachment source")
  const attachmentPath = join(root, "transient-attachment.txt")
  writeFileSync(attachmentPath, "durable attachment bytes")
  const attachments = [
    {
      name: "transient-attachment.txt",
      mimeType: "text/plain",
      size: 24,
      path: attachmentPath,
    },
  ]
  const queuedId = randomUUID()
  owner.submit(retainedId, queuedId, "Queued attachment", attachments)
  unlinkSync(attachmentPath)
  owner.submit(retainedId, queuedId, "Queued attachment", attachments)
  finish(retainedId, "Ready for next request")
  await until(
    () =>
      owner
        .snapshot(retainedId)
        ?.requests.some(
          (request) =>
            request.id === queuedId && request.status === "dispatching"
        ) ?? false
  )
  assert.equal(
    readFileSync(sent.at(-1)!.attachments[0]!.path!, "utf8"),
    "durable attachment bytes"
  )
  writeFileSync(attachmentPath, "durable transfer bytes")
  const retainedTransfer = {
    ...command("beta", "Queued transfer attachment"),
    attachments,
  }
  owner.transfer(retainedId, retainedTransfer)
  unlinkSync(attachmentPath)
  owner.transfer(retainedId, retainedTransfer)
  finish(retainedId, "Ready to transfer")
  await until(
    () =>
      owner.snapshot(retainedId)?.session.harness === "beta" &&
      owner.snapshot(retainedId)?.session.status === "running"
  )
  assert.equal(
    readFileSync(sent.at(-1)!.attachments[0]!.path!, "utf8"),
    "durable transfer bytes"
  )

  console.log(
    "Transfers verified: stable identity, exact attachments, A→B→A delta, duplicate receipts, late events, busy ordering, startup refusal, close-during-start, lazy forks, merge-back, child permission/delivery/cancel, real MCP authorization, and restart recovery"
  )
} finally {
  await mcpClient?.close()
  mcp?.close()
  owner.stop()
  observerMemory.close()
  memory.close()
  rmSync(root, { recursive: true, force: true })
}
