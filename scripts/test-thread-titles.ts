import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadParent } from "@mako/host/contracts/agents"
import type { ThreadTitleEntry } from "@mako/host/contracts/thread-titles"
import { SessionIdSchema, type Actor } from "@mako/host/contracts/thread-identity"
import type { HelperRun } from "@mako/host/contracts/usage-ledger"
import { ThreadStore, TITLE_LEASE_MS } from "@mako/host/threads/store"
import {
  firstExchange, generatedTitle, promptCut, ThreadTitler, TITLE_ANSWER_CHARS, TITLE_INSTRUCTIONS, TITLE_MAX_CHARS, TITLE_PROMPT_CHARS, titlePrompt,
  type ThreadTitlerOptions, type TitledConversation, type TitleModel,
} from "@mako/host/threads/thread-titler"

/**
 * Generated Thread titles, with a model that answers from a script and never
 * a network: what a title is read from and what is sent, a reply's way to a
 * title, which Threads are asked about and which never are, once per
 * Thread across restarts and hosts, one retry, no connection, the switch,
 * a running turn, and that a rename always wins.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-titles-")))
const migration: Actor = { kind: "service", name: "migration" }
const PROMPT = "Please take a look at why the payments webhook retries forever after a 500, and fix it. Follow AGENTS.md."
const ANSWER = "The retry loop never counts attempts: `deliver` re-enqueues on every 5xx. I'll cap it at five with backoff."

type Session = TitledConversation["session"]
type Request = TitledConversation["requests"][number]
type Block = TitledConversation["blocks"][number]

/** A conversation as memory holds it once its first turn ended: its prompt, some tool work, the answer. */
function conversation(overrides: { title?: string; status?: Session["status"]; prompt?: string; answer?: string; request?: Request["status"]; more?: Block[] } = {}): TitledConversation {
  const request = randomUUID()
  const blocks: Block[] = [
    { type: "user", requestId: request, text: overrides.prompt ?? PROMPT },
    { type: "thinking", text: "The person wants the retry fixed." },
    ...(overrides.answer === "" ? [] : [{ type: "text" as const, text: overrides.answer ?? ANSWER }]),
    ...(overrides.more ?? []),
  ]
  const session: Session = { cwd: "/work/payments", status: overrides.status ?? "ready", ...(overrides.title !== undefined && { title: overrides.title }) }
  const requests: Request[] = [{ id: request, text: overrides.prompt ?? PROMPT, status: overrides.request ?? "completed" }]
  return { session, blocks, requests, base: null }
}

interface Desk {
  store: ThreadStore
  titler: ThreadTitler
  held: Map<string, TitledConversation>
  /** What the model was asked, in order. */
  asked: { instructions: string; prompt: string; maxOutputTokens: number }[]
  emitted: ThreadTitleEntry[]
  runs: HelperRun[]
  /** What the next requests answer: a reply, or an error to throw. */
  replies: (string | Error)[]
  state: { on: boolean; connected: boolean; native?: string; now: number }
  thread(overrides?: Parameters<typeof conversation>[0]): { conversation: string; thread: ReturnType<ThreadStore["registerJournal"]>["thread"]; session: string }
}

function desk(name: string, options: Partial<ThreadTitlerOptions> = {}): Desk {
  const state: Desk["state"] = { on: true, connected: true, now: 1_800_000_000_000 }
  const store = new ThreadStore(join(root, `${name}.sqlite`), { realPath: (path) => path, now: () => state.now })
  const held = new Map<string, TitledConversation>()
  const asked: Desk["asked"] = []
  const emitted: ThreadTitleEntry[] = []
  const runs: HelperRun[] = []
  const replies: (string | Error)[] = []
  const model: TitleModel = {
    id: "openai/gpt-mini",
    complete: async (request) => {
      asked.push(request)
      const reply = replies.shift() ?? "Fix payments webhook retry loop"
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  const titler = new ThreadTitler({
    store,
    enabled: async () => state.on,
    model: async (onUsage) => {
      if (!state.connected) return undefined
      return { ...model, complete: async (request, signal) => model.complete(request, signal).finally(() => onUsage({ input: 320, output: 9, cacheRead: 0, cacheWrite: 0 })) }
    },
    held: (id) => held.get(id),
    nativeTitle: () => state.native,
    emit: (titles) => void emitted.push(...titles),
    record: (run) => void runs.push(run),
    quietMs: 0,
    ...options,
  })
  return {
    store, titler, held, asked, emitted, runs, replies, state,
    thread(overrides) {
      const id = randomUUID()
      const placed = store.registerJournal({ conversationId: id, createdAt: state.now, harness: "cursor", bindings: [] }, migration)
      held.set(id, conversation(overrides))
      return { conversation: id, thread: placed.thread, session: placed.session }
    },
  }
}

function fin(child: ThreadParent["child"], parent: { thread: ThreadParent["parent"]; session: string }): ThreadParent {
  const session = SessionIdSchema.parse(parent.session)
  return {
    child, parent: parent.thread, parentSession: session, name: "fix-the-retry", role: "worker", origin: "started",
    asked: { brief: { objective: "Fix the retry" }, harness: "cursor" }, op: `start:${session}:${randomUUID()}`, startedBy: { kind: "agent", session }, createdAt: 1,
  }
}

try {
  // What a reply becomes.
  assert.equal(generatedTitle("Fix payments webhook retry loop"), "Fix payments webhook retry loop")
  assert.equal(generatedTitle('  "Fix payments webhook retry loop."  \n\nIt names the fix.'), "Fix payments webhook retry loop", "its first line, without quotes or a closing stop")
  assert.equal(generatedTitle("**Title:** “Cap webhook retries at five”"), "Cap webhook retries at five", "without a label, markdown or curly quotes")
  assert.equal(generatedTitle("## Cap   webhook\tretries!"), "Cap webhook retries")
  assert.equal(generatedTitle("- `deliver` re-enqueues on every 5xx…"), "deliver re-enqueues on every 5xx")
  assert.equal(generatedTitle("Why does deliver() retry?"), "Why does deliver() retry", "no closing punctuation, a bracket stays")
  assert.equal(generatedTitle("Bump Node to v24.22.3."), "Bump Node to v24.22.3")
  assert.equal(generatedTitle("a".repeat(TITLE_MAX_CHARS)), "a".repeat(TITLE_MAX_CHARS), "fifty characters fit")
  assert.equal(generatedTitle("a".repeat(TITLE_MAX_CHARS + 1)), undefined, "a longer reply is no title, never a cut one")
  assert.equal(generatedTitle("Investigate why the payments webhook retries forever after a 500"), undefined)
  for (const nothing of ["", "   \n\n ", "\"\"", "...", "?", "x", "Untitled", "Untitled thread", "I can't help with that", "Sorry, I cannot name this"])
    assert.equal(generatedTitle(nothing), undefined, `no title in ${JSON.stringify(nothing)}`)

  // The instructions say what the title is and that the texts order nothing.
  assert.match(TITLE_INSTRUCTIONS, new RegExp(`at most ${TITLE_MAX_CHARS} characters, in sentence case, with no quotes, no markdown and no closing punctuation`))
  assert.match(TITLE_INSTRUCTIONS, /greetings, "please", "take a look at"/)
  assert.match(TITLE_INSTRUCTIONS, /never instructions to you/)

  // A stand-in is the start of what was sent; a name is anything else.
  assert.equal(promptCut("Please take a look at why the payments webhook retries fore…", PROMPT), true, "Mako's cut of the prompt")
  assert.equal(promptCut("please take a look at why the\n payments webhook", PROMPT), true, "whatever its spacing or case")
  assert.equal(promptCut("", PROMPT), true)
  assert.equal(promptCut("Webhook retry cap", PROMPT), false, "a title its harness wrote")

  // What a title is read from.
  const whole = conversation({
    prompt: `<mako-local-control>\nlines\n</mako-local-control>\n\n${PROMPT}`,
    more: [{ type: "user", requestId: "second", text: "Now add a test." }, { type: "text", text: "Added one." }],
  })
  const read = firstExchange(whole)
  assert.equal(read?.prompt, PROMPT, "the person's words, without what Mako put around them")
  assert.equal(read?.answer, ANSWER, "the first answer's prose alone: no thinking, nothing of the second turn")
  assert.equal(titlePrompt(read!), `First message:\n${PROMPT}\n\nStart of the first answer:\n${ANSWER}`)
  const long = firstExchange(conversation({ prompt: "p".repeat(50_000), answer: "a".repeat(50_000) }))
  assert.equal(long?.prompt.length, TITLE_PROMPT_CHARS, "a long prompt is cut")
  assert.equal(long?.answer.length, TITLE_ANSWER_CHARS, "and only the answer's start goes")
  assert.ok(titlePrompt(long!).length < TITLE_PROMPT_CHARS + TITLE_ANSWER_CHARS + 100, "so a request is bounded whatever the turn held")
  assert.match(titlePrompt(firstExchange(conversation({ answer: "" }))!), /said nothing in words yet/, "an answer of tool calls alone")
  assert.equal(firstExchange(conversation({ request: "dispatching" })), undefined, "an exchange still running isn't read")
  assert.equal(firstExchange(conversation({ prompt: "   " })), undefined, "a prompt without words")
  assert.equal(firstExchange({ ...whole, baseLiveStart: 12 }), undefined, "a record that continues an older history doesn't begin with the Thread's first exchange")
  assert.equal(firstExchange({ ...whole, baseLiveStart: 0 })?.prompt, PROMPT)
  assert.equal(firstExchange({ ...whole, blocks: whole.blocks.slice(3) }), undefined, "nor one whose first turn is a later request's")

  // One request, once: the title is written as the Thread's `auto` title and told to every window.
  {
    const d = desk("once")
    const t = d.thread()
    await d.titler.look(t.conversation)
    assert.deepEqual(d.asked.length, 1)
    assert.equal(d.asked[0]!.instructions, TITLE_INSTRUCTIONS)
    assert.equal(d.asked[0]!.prompt, `First message:\n${PROMPT}\n\nStart of the first answer:\n${ANSWER}`)
    assert.deepEqual(d.store.titleEntry(t.thread), { thread: t.thread, title: "Fix payments webhook retry loop", source: "auto" })
    assert.deepEqual(d.emitted, [{ thread: t.thread, title: "Fix payments webhook retry loop", source: "auto" }])
    assert.deepEqual(d.runs.map(({ purpose, connection, outcome, calls, tokens, cwd }) => ({ purpose, connection, outcome, calls, tokens, cwd })),
      [{ purpose: "thread-title", connection: "openai/gpt-mini", outcome: "completed", calls: 1, tokens: { input: 320, output: 9, cacheRead: 0, cacheWrite: 0 }, cwd: "/work/payments" }], "its spend is a helper run")
    await d.titler.look(t.conversation)
    await d.titler.look(t.conversation)
    assert.equal(d.asked.length, 1, "later turns ask nothing")
    d.store.close()

    // A restart, and another host on the same store, ask nothing either.
    const again = desk("once")
    again.held.set(t.conversation, conversation())
    await again.titler.look(t.conversation)
    assert.equal(again.asked.length, 0, "after a restart")
    assert.equal(again.store.titleEntry(t.thread)?.title, "Fix payments webhook retry loop")

    // The person's rename replaces it, and dropping the name asks for no new one.
    again.store.renameThread({ operationId: randomUUID(), thread: t.thread, title: "Webhook retries", actor: again.store.person() })
    assert.deepEqual(again.store.titleEntry(t.thread), { thread: t.thread, title: "Webhook retries", source: "user" })
    again.store.clearThreadTitle({ operationId: randomUUID(), thread: t.thread, actor: again.store.person() })
    await again.titler.look(t.conversation)
    assert.equal(again.asked.length, 0)
    assert.deepEqual(again.store.titleEntry(t.thread), { thread: t.thread, title: null })
    again.store.close()
  }

  // A turn's end is looked at after the quiet time, not on the turn's path.
  {
    const d = desk("timer")
    const t = d.thread()
    d.titler.turnEnded(t.conversation)
    d.titler.turnEnded(t.conversation)
    assert.equal(d.asked.length, 0, "nothing is asked as the turn ends")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await d.titler.look(randomUUID())
    assert.equal(d.asked.length, 1, "two ends in the quiet time are one look")
    assert.equal(d.store.titleEntry(t.thread)?.source, "auto")
    const closed = d.thread()
    d.titler.close()
    d.titler.turnEnded(closed.conversation)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(d.asked.length, 1, "a stopping host asks nothing")
    d.store.close()
  }

  // Threads that are never asked about, and never written.
  {
    const d = desk("never")
    const unasked = async (label: string, t: { conversation: string; thread: Desk["emitted"][number]["thread"] }) => {
      await d.titler.look(t.conversation)
      assert.equal(d.asked.length, 0, label)
      assert.equal(d.emitted.length, 0, label)
    }
    const renamed = d.thread()
    d.store.renameThread({ operationId: randomUUID(), thread: renamed.thread, title: "Mine", actor: d.store.person() })
    await unasked("a Thread the person renamed", renamed)
    assert.deepEqual(d.store.titleEntry(renamed.thread), { thread: renamed.thread, title: "Mine", source: "user" })

    const setup = d.thread()
    d.store.markPurpose(setup.thread, "setup", "/work/payments")
    await unasked("a Thread Mako started for a purpose", setup)
    d.store.keepThreadTitle(setup.thread, "Set up payments")
    await unasked("with the name Mako froze", setup)
    assert.deepEqual(d.store.titleEntry(setup.thread), { thread: setup.thread, title: "Set up payments", source: "frozen" })

    const apex = d.thread({ title: "Chosen at its start" })
    const child = d.thread()
    d.store.keepEdge(fin(child.thread, apex))
    await unasked("a Fin, whose Apex named it", child)
    const run = d.thread()
    d.store.keepEdge({ ...fin(run.thread, apex), name: "payments-suite", origin: "discovered", run: { harness: "codex", nativeId: "run-1", device: d.store.deviceId, startedAt: 1 } })
    await unasked("a linked run", run)
    await unasked("a session somebody named at its start", apex)

    const native = d.thread({ title: "Please take a look at why the payments webhook retries fore…" })
    d.state.native = "Webhook retry cap"
    await unasked("a session its harness named", native)
    d.state.native = undefined

    const tab = d.thread()
    const second = d.store.createSession({ operationId: randomUUID(), thread: tab.thread, actor: d.store.person() })
    const other = randomUUID()
    d.store.registerJournal({ conversationId: other, createdAt: d.state.now, harness: "codex", bindings: [], session: second.session }, migration)
    d.held.set(other, conversation())
    await unasked("a Thread's second Session", { conversation: other, thread: tab.thread })

    const streaming = d.thread({ status: "running" })
    await unasked("a conversation running a turn", streaming)
    const queued = d.thread()
    const sent = d.held.get(queued.conversation)!
    d.held.set(queued.conversation, { ...sent, requests: [...sent.requests, { id: randomUUID(), text: "And the tests.", status: "queued" }] })
    await unasked("one with a message waiting to go", queued)
    const unsettled = d.thread({ request: "dispatching" })
    await unasked("a first exchange that hasn't settled", unsettled)
    const older = d.thread()
    d.held.set(older.conversation, { ...d.held.get(older.conversation)!, baseLiveStart: 40 })
    await unasked("a record that continues an older history", older)
    const onDisk = d.thread()
    d.held.delete(onDisk.conversation)
    await unasked("a conversation only on disk, which is not read in", onDisk)
    await unasked("a conversation the store never placed", { conversation: randomUUID(), thread: onDisk.thread })
    for (const t of [child, run, apex, native, streaming, queued, unsettled, older, onDisk])
      assert.deepEqual(d.store.titleEntry(t.thread), { thread: t.thread, title: null }, "and none has a title")

    // The turn ends, and then it is asked: nothing had been counted against it.
    d.held.set(streaming.conversation, conversation())
    await d.titler.look(streaming.conversation)
    assert.equal(d.asked.length, 1, "once its turn has ended")
    assert.equal(d.store.titleEntry(streaming.thread)?.source, "auto")
    d.store.close()
  }

  // A turn that starts, or a rename, while the connection is being opened: nothing is asked.
  {
    const d = desk("meanwhile")
    const t = d.thread()
    const titler = new ThreadTitler({
      store: d.store, enabled: async () => true, held: (id) => d.held.get(id), emit: (titles) => void d.emitted.push(...titles),
      model: async () => {
        d.held.set(t.conversation, conversation({ status: "running" }))
        return { id: "openai/gpt-mini", complete: async (request) => { d.asked.push(request); return "Too late" } }
      },
    })
    await titler.look(t.conversation)
    assert.equal(d.asked.length, 0, "the turn that started meanwhile is not titled mid-stream")
    assert.equal(d.store.generatedTitleOpen(t.thread), true, "and nothing was counted against the Thread")

    // A rename while the model answers wins over the answer.
    const racing = d.thread()
    const racer = new ThreadTitler({
      store: d.store, enabled: async () => true, held: (id) => d.held.get(id), emit: (titles) => void d.emitted.push(...titles),
      model: async () => ({
        id: "openai/gpt-mini",
        complete: async () => {
          d.store.renameThread({ operationId: randomUUID(), thread: racing.thread, title: "Mine first", actor: d.store.person() })
          return "The model's late title"
        },
      }),
    })
    await racer.look(racing.conversation)
    assert.deepEqual(d.store.titleEntry(racing.thread), { thread: racing.thread, title: "Mine first", source: "user" }, "the person's name stands")
    assert.deepEqual(d.emitted, [], "and no window is told of the model's")
    d.store.close()
  }

  // A failed request, or a reply that is no title, is asked once more at a later turn's end, then left.
  {
    const d = desk("retry")
    const failed = d.thread()
    d.replies.push(new Error("429 rate limited: First message: Please take a look"), "x".repeat(80))
    await d.titler.look(failed.conversation)
    assert.equal(d.asked.length, 1)
    assert.deepEqual(d.store.titleEntry(failed.thread), { thread: failed.thread, title: null }, "a failure leaves the row as it was, with no error on it")
    assert.deepEqual(d.emitted, [])
    assert.equal(d.runs[0]?.outcome, "failed")
    await d.titler.look(failed.conversation)
    assert.equal(d.asked.length, 2, "one more request, at the next turn's end")
    assert.deepEqual(d.store.titleEntry(failed.thread), { thread: failed.thread, title: null }, "a reply too long to be a title falls back to nothing")
    await d.titler.look(failed.conversation)
    await d.titler.look(failed.conversation)
    assert.equal(d.asked.length, 2, "and never a third")
    d.store.close()
    const restarted = desk("retry")
    restarted.held.set(failed.conversation, conversation())
    await restarted.titler.look(failed.conversation)
    assert.equal(restarted.asked.length, 0, "a restart doesn't start the count over")

    const second = restarted.thread()
    restarted.replies.push("", "Cap webhook retries")
    await restarted.titler.look(second.conversation)
    assert.deepEqual(restarted.store.titleEntry(second.thread), { thread: second.thread, title: null }, "an empty reply is nothing")
    await restarted.titler.look(second.conversation)
    assert.deepEqual(restarted.store.titleEntry(second.thread), { thread: second.thread, title: "Cap webhook retries", source: "auto" }, "the retry's title is kept")
    restarted.store.close()
  }

  // No connection, or the switch off: nothing is asked, nothing counted, and the row shows what it did.
  {
    const d = desk("off")
    const t = d.thread()
    d.state.connected = false
    await d.titler.look(t.conversation)
    d.state.connected = true
    d.state.on = false
    await d.titler.look(t.conversation)
    assert.equal(d.asked.length, 0)
    assert.deepEqual(d.store.titleEntry(t.thread), { thread: t.thread, title: null })
    assert.equal(d.store.generatedTitleOpen(t.thread), true, "a Thread nothing was asked about is still open")
    d.state.on = true
    await d.titler.look(t.conversation)
    assert.equal(d.asked.length, 1, "once a key is connected and the switch is on, its next turn's end titles it")
    d.store.close()
  }

  // Two hosts on one store: one asks, the other finds the Thread taken, then titled.
  {
    const one = desk("hosts")
    const two = desk("hosts")
    const t = one.thread()
    two.held.set(t.conversation, conversation())
    assert.equal(one.store.claimGeneratedTitle({ thread: t.thread, conversation: t.conversation, holder: "host-one" }), true)
    await two.titler.look(t.conversation)
    assert.equal(two.asked.length, 0, "a Thread another host is asking about is left to it")
    assert.equal(two.store.writeGeneratedTitle({ thread: t.thread, holder: "host-two", title: "Not its claim" }), undefined, "only the claim's holder writes")
    // A host that stopped while asking has asked once: after the lease, one more request and no third.
    two.state.now += TITLE_LEASE_MS + 1
    two.replies.push(new Error("timeout"))
    await two.titler.look(t.conversation)
    await two.titler.look(t.conversation)
    assert.equal(two.asked.length, 1)
    assert.equal(two.store.generatedTitleOpen(t.thread), false)
    one.store.close()
    two.store.close()
  }

  console.log("thread titles: a reply's way to a title, what is read and sent, once per Thread across restarts and hosts, each Thread never asked about, a running turn, a rename over a late answer, one retry, no connection, the switch")
} finally {
  rmSync(root, { recursive: true, force: true })
}
