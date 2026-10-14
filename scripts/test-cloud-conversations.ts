import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Payload, RuntimeThreads, type ClientSession, type ClientSessionOverSockets, type Subscription } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { Git } from "@mako/git"
import { CloudConversations, folderRepository } from "@mako/host/conversations/cloud-conversations"
import type { CloudRepository } from "@mako/host/contracts/cloud-threads"
import { githubRepositoryUrl } from "@mako/host/contracts/cloud-threads"
import { decodeRuntimeValue, encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent } from "@mako/host/contracts/runtime-value"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import type { CloudAccount } from "@mako/host/usage/cloud-account-methods"
import { z } from "zod"

const CLONE = "/home/node/work/octocat/Hello-World"
const REPOSITORY: CloudRepository = { url: "https://github.com/octocat/Hello-World" }
const scratch = await mkdtemp(join(tmpdir(), "mako-cloud-conversations-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** A cloud machine's host behind the fake gateway: what it was asked, and its Thread's event outbox. */
async function cloudMachine() {
  const gateway = createFakeGateway()
  const runtimeId = "m-0123456789abcdef.g1"
  const threads = new RuntimeThreads()
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), {
    runtimeId,
    build: "test",
    threads,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === "mako:boot") return JSON.stringify({ activeTabId: "tab-1", tabs: [{ id: "tab-1", session: { meta: { cwd: CLONE } } }] })
      if (channel === "mako:live-start") {
        const [harness, cwd, options] = z.tuple([z.string(), z.string(), z.object({ conversationId: z.string() }).loose()]).parse(args)
        return JSON.stringify({ session: { id: options.conversationId, harness, cwd, status: "running" }, revision: 1, createdAt: 1, requests: [] })
      }
      return JSON.stringify({ channel })
    },
  })
  after(() => served.close())
  const deviceId = randomUUID()
  const client = await gateway.connectClient({ kind: "client", client: "desktop", deviceId })
  const created: string[] = []
  const account: CloudAccount = {
    token: async () => "token",
    id: async () => "account",
    deviceId: async () => deviceId,
    session: () => sessionOf(client),
    createThread: async (threadId, repository) => {
      assert.deepEqual(repository, REPOSITORY)
      created.push(threadId)
      await gateway.assign(threadId, runtimeId)
    },
    wake: () => {},
    stop: () => {},
  }
  /** One of the machine host's live batches, on its Thread's stream as the machine sends it. */
  const batch = (threadId: string, conversation: string, revision: number, status: string) => {
    // SAFETY: a batch as the machine's live driver sends it, filled only as far as the router and summary read it.
    const event = encodeRuntimeEvent({ type: "live-batch", batch: { id: conversation, revision, updates: [], sessionChanges: { status } } } as never)
    return threads.emit(threadId, Payload.encoded(runtimeEventLine("event", event).slice(0, -1)))
  }
  return { account, calls, created, batch }
}

/** The fake gateway's client session as the account's session is: opened at once, used as it opens. */
function sessionOf(client: ClientSession): ClientSessionOverSockets {
  return {
    call: (operation) => client.call(operation),
    subscribe: (request): Subscription => client.subscribe(request),
    close: () => {},
  }
}

function conversations(account: CloudAccount, file: string) {
  const events: RuntimeEvent[] = []
  const router = new CloudConversations({ account: () => account, file, emit: (event) => events.push(event), repositoryOf: async () => REPOSITORY })
  after(() => router.dispose())
  return { router, events }
}

async function until(what: string, check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("a cloud start makes the Thread once, starts on the machine in its clone, and relays the conversation's events", async () => {
  const machine = await cloudMachine()
  const file = join(scratch, "start", "conversations.json")
  const { router, events } = conversations(machine.account, file)
  const conversationId = randomUUID()
  const options = { conversationId, cloud: { repository: REPOSITORY }, worktree: true, threadPath: "/Users/me/x.jsonl", initialRequest: { id: "r-1", text: "hi", attachments: [] } }
  const started = await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.ok(started.handled)
  assert.equal(z.object({ session: z.object({ id: z.string() }) }).parse(decodeRuntimeValue(started.value)).session.id, conversationId)
  const start = machine.calls.find((call) => call.channel === "mako:live-start")
  assert.equal(start?.args[1], CLONE, "the turn runs in the machine's clone, not this Mac's folder")
  const sent = z.object({ initialRequest: z.unknown() }).loose().parse(start?.args[2])
  for (const key of ["cloud", "worktree", "threadPath"]) assert.equal(key in sent, false, `${key} stays on this Mac`)
  assert.deepEqual(sent.initialRequest, options.initialRequest)

  await router.route("mako:live-start", ["claude", "/Users/me/project", options])
  assert.equal(machine.created.length, 1, "a repeated start makes no second Thread")

  const [threadId] = machine.created
  machine.batch(threadId!, conversationId, 2, "ready")
  machine.batch(threadId!, "another-conversation", 1, "ready")
  await until("the batch relayed", () => events.length === 1)
  assert.equal(events[0]?.conversation, conversationId)
  assert.equal(JSON.parse(events[0]!.payload).batch.revision, 2)
  await until("the summary updated", () => router.summaries()[0]?.session.status === "ready")
  assert.equal(router.summaries()[0]?.revision, 2)

  const prompted = await router.route("mako:live-prompt", [conversationId, "r-2", "again", [], undefined])
  assert.ok(prompted.handled)
  assert.ok(machine.calls.some((call) => call.channel === "mako:live-prompt" && call.args[0] === conversationId))
  assert.equal((await router.route("mako:live-prompt", ["not-a-cloud-one", "r-3", "x", [], undefined])).handled, false)
  assert.equal((await router.route("mako:live-start", ["claude", "/Users/me/project", { conversationId: randomUUID() }])).handled, false, "a start without cloud is this Mac's")
})

test("a Mac that restarts lists its cloud conversations and follows each from the last event it relayed", async () => {
  const machine = await cloudMachine()
  const file = join(scratch, "restart", "conversations.json")
  const first = conversations(machine.account, file)
  const conversationId = randomUUID()
  await first.router.route("mako:live-start", ["codex", "/Users/me/project", { conversationId, cloud: { repository: REPOSITORY } }])
  const [threadId] = machine.created
  machine.batch(threadId!, conversationId, 2, "running")
  await until("the first batch", () => first.events.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  first.router.dispose()

  // While this Mac was away, the turn finished on the machine.
  machine.batch(threadId!, conversationId, 3, "ready")
  const second = conversations(machine.account, file)
  await second.router.start()
  assert.equal(second.router.summaries()[0]?.session.id, conversationId)
  await until("the missed batch", () => second.events.length === 1)
  assert.equal(JSON.parse(second.events[0]!.payload).batch.revision, 3, "only what it hadn't relayed")
  await until("the summary caught up", () => second.router.summaries()[0]?.session.status === "ready")
})

test("a repository the cloud wouldn't take is refused before anything is made", async () => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "refused", "conversations.json"))
  await assert.rejects(router.route("mako:live-start", ["claude", "/x", { conversationId: randomUUID(), cloud: { repository: { url: "https://gitlab.com/a/b" } } }]))
  assert.equal(machine.created.length, 0)
})

test("a start that names no repository works in the folder's origin, on its upstream branch", async () => {
  const machine = await cloudMachine()
  const { router } = conversations(machine.account, join(scratch, "folder", "conversations.json"))
  await router.route("mako:live-start", ["grok", "/Users/me/project", { conversationId: randomUUID(), cloud: {} }])
  assert.equal(machine.created.length, 1)

  const git = new Git()
  const folder = join(scratch, "folder", "project")
  await mkdir(folder, { recursive: true })
  const output = (args: string[]) => git.output(folder, args)
  await output(["init", "--quiet", "--initial-branch", "main"])
  await assert.rejects(folderRepository(git, folder), /GitHub repository/)
  await output(["remote", "add", "origin", "git@github.com:octocat/Hello-World.git"])
  assert.deepEqual(await folderRepository(git, folder), REPOSITORY, "no upstream: the repository's default branch")
  await output(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "one"])
  await output(["update-ref", "refs/remotes/origin/feature", "HEAD"])
  await output(["branch", "--quiet", "--set-upstream-to", "origin/feature"])
  assert.deepEqual(await folderRepository(git, folder), { ...REPOSITORY, branch: "feature" })
})

test("a Git remote names its GitHub repository as the cloud takes it", () => {
  assert.equal(githubRepositoryUrl("git@github.com:Verbiflow/mako.git"), "https://github.com/Verbiflow/mako")
  assert.equal(githubRepositoryUrl("https://github.com/octocat/Hello-World.git"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("ssh://git@github.com/octocat/Hello-World"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("https://user@github.com/octocat/Hello-World/"), "https://github.com/octocat/Hello-World")
  assert.equal(githubRepositoryUrl("git@gitlab.com:a/b.git"), undefined)
})
