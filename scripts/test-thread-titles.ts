import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveUpdate } from "../electron/contracts/live-content.js"
import type { HostEvent } from "../electron/contracts/host-events-boot.js"
import type { ThreadTitleEntry } from "../electron/contracts/thread-titles.js"
import type { Actor, ThreadId } from "../electron/contracts/thread-identity.js"
import { LiveConversations } from "../electron/live-conversations.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { LiveSessionState } from "../electron/shared.js"
import { TITLE_ANSWER_CHARS, TITLE_PROMPT_CHARS, ThreadStore } from "../electron/thread-store.js"
import { resolveTitleModel } from "../electron/thread-title-model.js"
import { ThreadTitler, TitleModelError, completedExchange, parseTitle, titlePrompt, type TitleModel } from "../electron/thread-titles.js"
import { UtilityModelStore, type UtilityKeyEncryption } from "../electron/utility-model-store.js"

/**
 * Automatic Thread titles against a fake model: a topic change renames, a
 * rename during generation wins, late and duplicate answers lose, a restart
 * keeps provenance, a missing or failing model changes nothing, bursts
 * cost one request, a merged Thread is left alone, multi-Session Threads
 * read their latest exchanges by completion time, and every registered
 * harness reaches the hook through the conversation host.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-titles-")))
const migration: Actor = { kind: "service", name: "migration" }
const QUIET = 15
const SPACING = 60

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await delay(2)
  assert.ok(check(), what)
}

function openStore(name: string): ThreadStore {
  return new ThreadStore(join(root, `${name}.sqlite`), { realPath: (path) => path })
}

function newThread(store: ThreadStore, harness = "claude") {
  const conversation = randomUUID()
  const placed = store.registerJournal({ conversationId: conversation, createdAt: Date.now(), harness, bindings: [] }, migration)
  return { conversation, thread: placed.thread }
}

/** Names a conversation after the last word its latest prompt ends on, in the forms models reply with. */
function topicOf(prompt: string): string {
  const latest = prompt.slice(prompt.lastIndexOf("Latest exchange"))
  const person = /Person: (.*)/.exec(latest)?.[1] ?? ""
  return person.trim().split(/\s+/).at(-1) ?? ""
}

class FakeModel {
  calls: string[] = []
  reply: (prompt: string, signal: AbortSignal) => Promise<string> = async (prompt) => `Title: "**${topicOf(prompt)} work**."`
  kind: TitleModel["kind"] = "ready"
  resolution = async (): Promise<TitleModel> => {
    if (this.kind === "off") return { kind: "off" }
    if (this.kind === "unavailable") return { kind: "unavailable", reason: "google/gemini is no longer connected." }
    return {
      kind: "ready",
      id: "fake/model",
      complete: (_instructions, prompt, signal) => {
        this.calls.push(prompt)
        return this.reply(prompt, signal)
      },
    }
  }
}

function titler(store: ThreadStore, model: FakeModel, told: ThreadTitleEntry[] = [], options: { spacingMs?: number } = {}): ThreadTitler {
  const named = new ThreadTitler({
    store,
    model: model.resolution,
    emit: (titles) => { told.push(...titles) },
    quietMs: QUIET,
    spacingMs: options.spacingMs ?? 0,
    maxWaitMs: 200,
    pauseMs: 60_000,
  })
  named.configure(true)
  return named
}

let clock = 1_000
function finish(named: ThreadTitler, conversation: string, prompt: string, answer = `Done with ${prompt}.`, requestId = randomUUID()): string {
  named.exchange({ conversationId: conversation, requestId, completedAt: clock++, prompt, answer, nativeTitle: "Native title" })
  return requestId
}

function title(store: ThreadStore, thread: ThreadId): string | null | undefined {
  return store.titleEntry(thread)?.title
}

async function topicChange(): Promise<void> {
  const store = openStore("topic")
  const model = new FakeModel()
  const told: ThreadTitleEntry[] = []
  const named = titler(store, model, told)
  const { conversation, thread } = newThread(store)
  finish(named, conversation, "Fix the failing parser")
  await until(() => title(store, thread) === "parser work", "the first exchange names the Thread")
  assert.equal(store.titleEntry(thread)?.source, "auto")
  assert.deepEqual(told.at(-1), { thread, title: "parser work", source: "auto" }, "windows are told the new name")
  assert.equal(store.originalTitle(thread), "Native title", "the name it had before is kept apart")
  finish(named, conversation, "Now draft the release notes")
  await until(() => title(store, thread) === "notes work", "a topic change renames it from the latest exchange")
  assert.equal(model.calls.length, 2)
  assert.match(model.calls[1] ?? "", /Current title: parser work/, "the model sees the current title")
  assert.ok((model.calls[1] ?? "").indexOf("Fix the failing parser") < (model.calls[1] ?? "").indexOf("draft the release notes"), "oldest exchange first")
  named.close()
  store.close()
}

async function renameDuringGeneration(): Promise<void> {
  const store = openStore("rename")
  const model = new FakeModel()
  let release: (() => void) | undefined
  model.reply = (prompt) => new Promise((resolve) => { release = () => resolve(`${topicOf(prompt)} work`) })
  const named = titler(store, model)
  const first = newThread(store)
  finish(named, first.conversation, "Look at the parser")
  await until(() => model.calls.length === 1, "naming starts")
  // A person on another host renames: this host's titler never hears of it.
  store.renameThread({ operationId: randomUUID(), thread: first.thread, title: "My parser", actor: store.person() })
  release?.()
  await delay(QUIET * 3)
  assert.deepEqual(store.titleEntry(first.thread), { thread: first.thread, title: "My parser", source: "user" }, "an answer in flight loses to the rename")
  finish(named, first.conversation, "And the lexer")
  await delay(QUIET * 4)
  assert.equal(model.calls.length, 1, "a renamed Thread is not asked about again")

  // A rename here cancels the request in flight.
  const second = newThread(store)
  finish(named, second.conversation, "Profile the server")
  await until(() => model.calls.length === 2, "naming starts")
  store.renameThread({ operationId: randomUUID(), thread: second.thread, title: "Mine", actor: store.person() })
  named.cancel(second.thread)
  release?.()
  await delay(QUIET * 3)
  assert.equal(title(store, second.thread), "Mine")

  // A build from before automatic titles renames without counting revisions.
  const third = newThread(store)
  finish(named, third.conversation, "Trace the crash")
  await until(() => model.calls.length === 3, "naming starts")
  const db = new DatabaseSync(join(root, "rename.sqlite"))
  db.prepare("UPDATE threads SET title = 'Crash notes', title_source = 'user' WHERE id = ?").run(third.thread)
  db.close()
  release?.()
  await delay(QUIET * 3)
  assert.equal(title(store, third.thread), "Crash notes", "an older build's rename also wins over an answer in flight")
  assert.deepEqual(store.clearThreadTitle({ operationId: randomUUID(), thread: third.thread, actor: store.person() }), { thread: third.thread, title: null },
    "and the late answer was not kept underneath it")

  // Giving the name back lets automatic titles in again.
  model.reply = async (prompt) => `${topicOf(prompt)} work`
  const cleared = store.clearThreadTitle({ operationId: randomUUID(), thread: second.thread, actor: store.person() })
  assert.deepEqual(cleared, { thread: second.thread, title: null }, "with no automatic title yet the row shows its Session's")
  finish(named, second.conversation, "Profile the database")
  await until(() => title(store, second.thread) === "database work", "a cleared name is automatic again")
  named.close()
  store.close()
}

async function outOfOrder(): Promise<void> {
  const path = "order"
  const one = openStore(path)
  const two = openStore(path)
  const slow = new FakeModel()
  const fast = new FakeModel()
  let releaseSlow: (() => void) | undefined
  slow.reply = (prompt) => new Promise((resolve) => { releaseSlow = () => resolve(`${topicOf(prompt)} work`) })
  fast.reply = async (prompt) => `${topicOf(prompt)} work`
  const hostOne = titler(one, slow)
  const hostTwo = titler(two, fast)
  const { conversation, thread } = newThread(one)
  finish(hostOne, conversation, "Start on the cache")
  await until(() => slow.calls.length === 1, "the first host asks about the first window")
  // The same Thread's next exchange finishes on another host while the first answer is out.
  finish(hostTwo, conversation, "Switch to the scheduler")
  await until(() => title(two, thread) === "scheduler work", "the newer window is named")
  releaseSlow?.()
  await delay(QUIET * 3)
  assert.equal(title(one, thread), "scheduler work", "the older answer, arriving last, loses")
  assert.equal(slow.calls.length + fast.calls.length, 2)
  hostOne.close()
  hostTwo.close()
  one.close()
  two.close()
}

async function duplicates(): Promise<void> {
  const store = openStore("duplicates")
  const other = openStore("duplicates")
  const model = new FakeModel()
  const named = titler(store, model)
  const { conversation, thread } = newThread(store)
  const request = finish(named, conversation, "Tune the renderer")
  finish(named, conversation, "Tune the renderer", undefined, request)
  assert.equal(other.noteExchange({ session: store.journalPlacement(conversation)!.session, exchange: request, completedAt: 5, prompt: "x", answer: "y" }), false,
    "another host reporting the same request keeps nothing new")
  await until(() => title(store, thread) === "renderer work", "named once")
  await delay(QUIET * 3)
  assert.equal(model.calls.length, 1, "a repeated report is one exchange and one request")
  named.close()
  store.close()
  other.close()
}

async function restartAndProvenance(): Promise<void> {
  const path = join(root, "restart.sqlite")
  const first = new ThreadStore(path)
  const model = new FakeModel()
  const named = titler(first, model)
  const auto = newThread(first)
  const user = newThread(first)
  finish(named, auto.conversation, "Wire the updater")
  await until(() => title(first, auto.thread) === "updater work", "named before the restart")
  first.renameThread({ operationId: randomUUID(), thread: user.thread, title: "Release checklist", actor: first.person() })
  named.close()
  first.close()

  const again = new ThreadStore(path)
  assert.deepEqual(again.titleEntry(auto.thread), { thread: auto.thread, title: "updater work", source: "auto" }, "an automatic title stays automatic")
  assert.deepEqual(again.titleEntry(user.thread), { thread: user.thread, title: "Release checklist", source: "user" }, "a rename stays the user's")
  const restarted = titler(again, model)
  const context = again.titleContext(auto.thread)
  assert.ok(context && context.answered === context.digest, "the window it answered is remembered")
  assert.equal(again.claimTitle({ thread: auto.thread, digest: context.digest, holder: "restarted" }), undefined, "unchanged context asks nothing")
  await delay(QUIET * 3)
  assert.equal(model.calls.length, 1, "a restart asks nothing")
  restarted.close()
  again.close()

  // A store from before automatic titles, holding a title with no source.
  const old = join(root, "before-titles.sqlite")
  const seeded = new ThreadStore(old)
  const legacy = newThread(seeded)
  const plain = newThread(seeded)
  seeded.close()
  const db = new DatabaseSync(old)
  db.exec("DROP TRIGGER thread_title_changed; DROP TABLE title_exchanges; DROP TABLE title_changes; DELETE FROM store_migrations WHERE version = 3")
  for (const column of ["original_title", "auto_title", "auto_context", "auto_at", "title_revision", "title_pending", "title_pending_at", "title_pending_by"])
    db.exec(`ALTER TABLE threads DROP COLUMN ${column}`)
  db.prepare("UPDATE threads SET title = 'Named elsewhere', title_source = NULL WHERE id = ?").run(legacy.thread)
  db.close()
  const migrated = new ThreadStore(old)
  assert.deepEqual(migrated.titleEntry(legacy.thread), { thread: legacy.thread, title: "Named elsewhere", source: "user" },
    "a title without a source is never assumed to be automatic")
  assert.deepEqual(migrated.titleEntry(plain.thread), { thread: plain.thread, title: null })
  const legacyModel = new FakeModel()
  const afterMigration = titler(migrated, legacyModel)
  finish(afterMigration, legacy.conversation, "Rewrite the importer")
  finish(afterMigration, plain.conversation, "Rewrite the exporter")
  await until(() => title(migrated, plain.thread) === "exporter work", "an untitled Thread is named after the migration")
  assert.equal(title(migrated, legacy.thread), "Named elsewhere", "the older title is kept")
  assert.equal(legacyModel.calls.length, 1)
  // A window's renames from before the store kept names are imported as the user's, once.
  const imported = migrated.importThreadTitles([{ thread: plain.thread, title: "Exporter rewrite" }, { thread: legacy.thread, title: "Ignored" }])
  assert.deepEqual(imported, [{ thread: plain.thread, title: "Exporter rewrite", source: "user" }],
    "an old window rename replaces an automatic title, but not a title someone gave the Thread")
  assert.equal(migrated.originalTitle(plain.thread), "Native title", "the original name survives the import")
  afterMigration.close()
  migrated.close()
}

async function importsAndFrozen(): Promise<void> {
  const store = openStore("imports")
  const model = new FakeModel()
  const named = titler(store, model)
  const renamed = newThread(store)
  const setup = newThread(store)
  assert.deepEqual(store.importThreadTitles([{ thread: renamed.thread, title: "Old window name" }]),
    [{ thread: renamed.thread, title: "Old window name", source: "user" }])
  assert.deepEqual(store.importThreadTitles([{ thread: renamed.thread, title: "Another" }]), [], "importing twice changes nothing")
  assert.equal(store.keepThreadTitle(setup.thread, "Set up mako")?.source, "frozen")
  finish(named, renamed.conversation, "Polish the rail")
  finish(named, setup.conversation, "Install the app")
  await delay(QUIET * 4)
  assert.equal(model.calls.length, 0, "user and frozen titles are never sent for replacement")
  assert.equal(title(store, setup.thread), "Set up mako")
  named.close()
  store.close()
}

async function unavailableAndFailing(): Promise<void> {
  const store = openStore("failing")
  const model = new FakeModel()
  const named = titler(store, model)
  const { conversation, thread } = newThread(store)
  model.kind = "unavailable"
  finish(named, conversation, "Fix the sidebar")
  await delay(QUIET * 4)
  assert.equal(model.calls.length, 0, "an unavailable model is not replaced by another")
  assert.equal(title(store, thread), null, "the Thread keeps its Session's name")

  model.kind = "ready"
  model.reply = async () => { throw new Error("network down") }
  finish(named, conversation, "Fix the toolbar")
  await until(() => model.calls.length === 1, "asked once")
  await delay(QUIET * 2)
  assert.equal(title(store, thread), null, "a failure changes nothing")
  const context = store.titleContext(thread)
  assert.ok(context && store.claimTitle({ thread, digest: context.digest, holder: "another host" }) !== undefined, "a failed request gives its lease back")
  store.releaseTitle({ thread, digest: context.digest, holder: "another host" })

  model.reply = async () => { throw new TitleModelError("auth", "The provider rejected this API key.", true) }
  finish(named, conversation, "Fix the footer")
  await until(() => model.calls.length === 2, "asked again for a new window")
  model.reply = async (prompt) => `${topicOf(prompt)} work`
  finish(named, conversation, "Fix the header")
  await delay(QUIET * 4)
  assert.equal(model.calls.length, 2, "a refused key pauses requests instead of repeating them")
  named.close()

  const off = new FakeModel()
  off.kind = "off"
  const quiet = titler(store, off)
  quiet.configure(false)
  const fresh = newThread(store)
  quiet.exchange({ conversationId: fresh.conversation, requestId: randomUUID(), completedAt: clock++, prompt: "Anything", answer: "Answer" })
  assert.equal(store.titleContext(fresh.thread)?.exchanges.length, 0, "with titles off no exchange is kept")
  quiet.close()
  store.close()
}

async function invalidOutput(): Promise<void> {
  assert.equal(parseTitle(""), undefined)
  assert.equal(parseTitle("   \n  "), undefined)
  assert.equal(parseTitle("\"\""), undefined)
  assert.equal(parseTitle("Untitled"), undefined)
  assert.equal(parseTitle("..."), undefined)
  assert.equal(parseTitle("## Title: \"Fix the parser.\"\nBecause the user asked"), "Fix the parser")
  assert.equal(parseTitle("“Ship the release”"), "Ship the release")
  const long = parseTitle(`${"word ".repeat(40)}end`)
  assert.ok(long && long.length <= 80 && !long.endsWith(" "), "a long reply is cut at a word")

  const store = openStore("invalid")
  const model = new FakeModel()
  const named = titler(store, model)
  const { conversation, thread } = newThread(store)
  model.reply = async () => "   "
  finish(named, conversation, "Speed up search")
  await until(() => model.calls.length === 1, "asked")
  await delay(QUIET * 2)
  assert.equal(title(store, thread), null, "an empty reply changes nothing")
  model.reply = async () => "**Untitled**"
  finish(named, conversation, "Speed up indexing")
  await until(() => model.calls.length === 2, "asked again for the next window")
  await delay(QUIET * 2)
  assert.equal(title(store, thread), null, "an invalid reply changes nothing")
  named.close()
  store.close()
}

async function boundedVolume(): Promise<void> {
  const store = openStore("volume")
  const model = new FakeModel()
  const named = titler(store, model, [], { spacingMs: SPACING })
  const { conversation, thread } = newThread(store)
  for (const word of ["alpha", "beta", "gamma", "delta", "epsilon"]) finish(named, conversation, `Work on ${word}`)
  await until(() => title(store, thread) === "epsilon work", "a burst is named from its end")
  assert.equal(model.calls.length, 1, "a burst of exchanges is one request")
  const prompt = model.calls[0] ?? ""
  assert.ok(prompt.includes("delta") && prompt.includes("epsilon") && !prompt.includes("gamma"), "the window is the latest two exchanges")

  const started = Date.now()
  finish(named, conversation, "Work on zeta")
  await until(() => title(store, thread) === "zeta work", "the next exchange is named")
  assert.ok(Date.now() - started >= SPACING - 10, "requests for one Thread are spaced")
  assert.equal(model.calls.length, 2)

  const big = "x".repeat(50_000)
  const exchange = completedExchange([
    { type: "user", text: big, requestId: "r" },
    { type: "thinking", text: "secret reasoning" },
    { type: "tool", id: "t", title: "Read", status: "completed", output: "tool output" },
    { type: "text", text: big },
  ], { id: "r", text: big, attachments: [], status: "completed" })
  assert.ok(exchange && exchange.prompt.length <= TITLE_PROMPT_CHARS && exchange.answer.length <= TITLE_ANSWER_CHARS, "an exchange is bounded")
  assert.ok(!exchange.answer.includes("secret") && !exchange.answer.includes("tool output"), "only the answer's prose is kept")
  const window = titlePrompt({ current: "A title", exchanges: [0, 1].map((index) => ({ session: store.journalPlacement(conversation)!.session, exchange: String(index), completedAt: index, ...exchange })) })
  assert.ok(window.length < 2 * (TITLE_PROMPT_CHARS + TITLE_ANSWER_CHARS) + 200, `a request is bounded (${window.length} characters)`)
  named.close()
  store.close()
}

async function mergedAway(): Promise<void> {
  const path = "merged"
  const store = openStore(path)
  const model = new FakeModel()
  let release: (() => void) | undefined
  model.reply = (prompt) => new Promise((resolve) => { release = () => resolve(`${topicOf(prompt)} work`) })
  const named = titler(store, model)
  const loser = newThread(store)
  const winner = newThread(store)
  finish(named, loser.conversation, "Clean up imports")
  await until(() => model.calls.length === 1, "naming starts")
  // Another host merges the Thread away while the answer is out.
  const db = new DatabaseSync(join(root, `${path}.sqlite`))
  db.prepare("UPDATE threads SET merged_into = ? WHERE id = ?").run(winner.thread, loser.thread)
  db.close()
  release?.()
  await delay(QUIET * 3)
  assert.equal(title(store, winner.thread), null, "a late answer for a Thread merged away names nothing")
  assert.equal(store.applyAutoTitle({ thread: loser.thread, digest: "x", revision: 0, title: "Late", holder: "h" }), "gone")
  // SAFETY: a fresh UUID is a well-formed Thread ID that names no Thread in this store.
  assert.equal(store.applyAutoTitle({ thread: randomUUID() as ThreadId, digest: "x", revision: 0, title: "Late", holder: "h" }), "gone",
    "a Thread the store no longer has takes nothing")
  named.close()
  store.close()
}

async function multiSession(): Promise<void> {
  const store = openStore("multi")
  const model = new FakeModel()
  const named = titler(store, model, [], { spacingMs: 0 })
  const first = newThread(store, "claude")
  const tab = store.createSession({ operationId: randomUUID(), thread: first.thread, actor: store.person() })
  const second = randomUUID()
  store.registerJournal({ conversationId: second, createdAt: Date.now(), harness: "codex", bindings: [], session: tab.session }, migration)
  assert.equal(store.journalPlacement(second)?.thread, first.thread)
  finish(named, first.conversation, "Plan the migration")
  await until(() => model.calls.length === 1, "named")
  finish(named, second, "Write the backfill")
  await until(() => model.calls.length === 2, "the other Session's exchange names the Thread")
  finish(named, first.conversation, "Verify the rollback")
  await until(() => title(store, first.thread) === "rollback work", "the latest exchange decides, whichever Session finished it")
  const prompt = model.calls[2] ?? ""
  assert.ok(prompt.indexOf("Write the backfill") >= 0 && prompt.indexOf("Write the backfill") < prompt.indexOf("Verify the rollback"),
    "exchanges across Sessions are ordered by when they finished")
  assert.ok(!prompt.includes("Plan the migration"), "the window holds only the latest two")

  const calls = model.calls.length
  store.createSession({ operationId: randomUUID(), thread: first.thread, actor: store.person() })
  await delay(QUIET * 3)
  assert.equal(model.calls.length, calls, "a membership change alone asks nothing")
  assert.equal(title(store, first.thread), "rollback work", "and renames nothing")
  named.close()
  store.close()
}

async function otherHostsHear(): Promise<void> {
  const one = openStore("hosts")
  const two = openStore("hosts")
  const { thread } = newThread(one)
  two.takeExternalTitles()
  one.renameThread({ operationId: randomUUID(), thread, title: "Shared name", actor: one.person() })
  assert.deepEqual(two.takeExternalTitles(), [{ thread, title: "Shared name", source: "user" }], "another host's rename reaches this host's windows")
  assert.deepEqual(two.takeExternalTitles(), [], "once")
  assert.deepEqual(one.takeExternalTitles(), [], "a host's own change is not news to it")
  one.close()
  two.close()
}

async function modelChoice(): Promise<void> {
  const directory = join(root, "utility-models")
  const encryption: UtilityKeyEncryption = {
    available: () => true,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  }
  const models = new UtilityModelStore(directory, encryption)
  assert.deepEqual(await resolveTitleModel(models), { kind: "off" }, "with no choice, titles are off")
  await assert.rejects(models.setTitleModel("google/gemini-flash"), /Connect this model/, "only a connected model can be chosen")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "google.enc"), JSON.stringify({ provider: "google", model: "gemini-flash", contextTokens: 100_000, apiKey: "test-key" }))
  writeFileSync(join(directory, "openai.enc"), JSON.stringify({ provider: "openai", model: "gpt-mini", contextTokens: 100_000, apiKey: "test-key" }))
  await models.setTitleModel("google/gemini-flash")
  assert.equal((await models.settings()).titleModel, "google/gemini-flash")
  const ready = await resolveTitleModel(models)
  assert.equal(ready.kind === "ready" && ready.id, "google/gemini-flash")
  writeFileSync(join(directory, "google.enc"), JSON.stringify({ provider: "google", model: "gemini-pro", contextTokens: 100_000, apiKey: "test-key" }))
  const moved = await resolveTitleModel(models)
  assert.equal(moved.kind, "unavailable", "a connection now naming another model doesn't stand in for the chosen one")
  assert.ok(moved.kind === "unavailable" && /no longer connected/.test(moved.reason))
  await models.disconnect("google")
  assert.equal(await models.titleModel(), null, "disconnecting the chosen provider turns titles off rather than moving them")
  assert.deepEqual(await resolveTitleModel(models), { kind: "off" }, "the other connection is not used")
}

/** A harness's turn, in the shape its decoder produces: prose, reasoning, tools and streamed chunks. */
function turn(harness: string, prompt: string): LiveUpdate[] {
  const topic = prompt.split(" ").at(-1)
  switch (harness) {
    case "claude":
      return [{ kind: "thinking", text: "Reasoning about it" }, { kind: "tool", id: randomUUID(), title: "Read", name: "Read", status: "completed", output: "file body" }, { kind: "text", text: `Changed the ${topic}.` }]
    case "codex":
      return [{ kind: "text", id: "m1", text: "Working" }, { kind: "text", id: "m1", text: `Changed the ${topic}.`, replace: true }]
    case "cursor":
      return [{ kind: "tool", id: "t1", title: "Edit", status: "running" }, { kind: "tool-update", id: "t1", status: "completed", output: "ok" }, { kind: "text", text: `Changed the ${topic}.` }]
    case "opencode":
      return [{ kind: "plan", entries: [{ content: "Step", status: "completed" }] }, { kind: "text", text: `Changed the ${topic}.` }]
    default:
      return [{ kind: "text", text: "Changed " }, { kind: "text", text: `the ${topic}.` }]
  }
}

async function everyHarness(): Promise<void> {
  const harnesses = registeredHarnessIds()
  assert.equal(harnesses.length, 6, "six harnesses are registered")
  const store = new ThreadStore(join(root, "hosted.sqlite"), { realPath: (path) => path })
  const model = new FakeModel()
  const named = titler(store, model)
  const journals = join(root, "journals")
  const host = (): LiveConversations => {
    let owner: LiveConversations | undefined
    const drivers = new Map<string, ProviderLiveDriver>(harnesses.map((harness) => {
      const sessions = new Map<string, LiveSessionState>()
      const driver: ProviderLiveDriver = {
        approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
        provider: harness,
        canResume: true,
        available: () => true,
        start: async (cwd, options) => {
          const session: LiveSessionState = {
            id: options.conversationId, nativeId: options.resume ?? `native-${harness}-${options.conversationId}`, harness, cwd,
            status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], title: `${harness} native title`,
          }
          sessions.set(options.conversationId, session)
          return session
        },
        prompt: async (id, text) => {
          const session = sessions.get(id)
          assert.ok(session && owner)
          owner.observe({ type: "live-session", session: { ...session, status: "running" } })
          owner.observe({ type: "live-updates", id, updates: turn(harness, String(text)) })
          owner.observe({ type: "live-session", session })
        },
        permission: async () => {},
        cancel: async () => {},
        setMode: async () => {},
        close: async () => {},
      }
      return [harness, driver]
    }))
    const events: HostEvent[] = []
    owner = new LiveConversations({
      root: journals,
      appPath: root,
      threads: store,
      driver: (provider) => drivers.get(provider),
      history: async () => null,
      emit: (event) => { events.push(event) },
      nativePath: (session) => session.nativeId ? join(root, "native", session.harness, `${session.nativeId}.jsonl`) : undefined,
      checkpoint: async () => "checkpoint",
      providerIdleMs: 60_000,
      providerWarmLimit: 20,
      exchangeCompleted: (exchange) => named.exchange(exchange),
    })
    return owner
  }
  const owner = host()
  const threads = new Map<string, ThreadId>()
  for (const harness of harnesses) {
    const id = randomUUID()
    await owner.start(harness, "/tmp/titles-project", { conversationId: id, initialRequest: { id: randomUUID(), text: `Please update the ${harness}`, attachments: [] } })
    await until(() => owner.snapshot(id)?.requests[0]?.status === "completed", `${harness}: the turn completes`)
    const placed = store.journalPlacement(id)
    assert.ok(placed)
    threads.set(harness, placed.thread)
  }
  for (const harness of harnesses) {
    const thread = threads.get(harness)!
    await until(() => title(store, thread) === `${harness} work`, `${harness}: the Thread is named from its exchange`)
    const context = store.titleContext(thread)
    assert.equal(context?.exchanges.length, 1)
    assert.equal(context?.exchanges[0]?.prompt, `Please update the ${harness}`, `${harness}: the prompt is the person's words`)
    assert.equal(context?.exchanges[0]?.answer, `Changed the ${harness}.`, `${harness}: the answer is its prose, without reasoning or tool output`)
    assert.equal(store.originalTitle(thread), `${harness} native title`, `${harness}: its native title is kept as the original name`)
  }
  assert.equal(model.calls.length, harnesses.length, "one request per finished exchange")
  await owner.stop()
  // Reopening every journal reports nothing again.
  const reopened = host()
  await delay(QUIET * 4)
  assert.equal(model.calls.length, harnesses.length, "a restart reports no exchange twice")
  await reopened.stop()
  named.close()
  store.close()
}

async function main(): Promise<void> {
  try {
    await topicChange()
    await renameDuringGeneration()
    await outOfOrder()
    await duplicates()
    await restartAndProvenance()
    await importsAndFrozen()
    await unavailableAndFailing()
    await invalidOutput()
    await boundedVolume()
    await mergedAway()
    await multiSession()
    await otherHostsHear()
    await modelChoice()
    await everyHarness()
    console.log("thread titles: topic change, rename in flight, out of order, duplicates, restart and provenance, imports, unavailable and failing models, invalid output, bounded volume, merged Thread, multi-Session order, other hosts, model choice, six harnesses")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
