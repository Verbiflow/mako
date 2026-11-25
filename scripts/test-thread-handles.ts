import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "@mako/host/contracts/thread-identity"
import { HANDLE_ALPHABET, HANDLE_CODE_LENGTH, HANDLE_LENGTH, handleCode, handleWord, threadCode, threadHandle } from "@mako/host/contracts/thread-handles"
import { conversationNamed, ThreadHandles } from "@mako/host/threads/thread-handles"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * A Thread's handle (`contracts/thread-handles.ts`) and the one resolver (`ThreadHandles`, `ThreadStore.threadByHandle`):
 * the same handle from the same ID every time, its word from the project's folder and never part of a lookup, a typed
 * handle read in any case with or without its word, a prefix of three characters, an unknown one and one two Threads
 * share, which names both a character longer; the store's index taking in Threads made after it was built; and the
 * conversation a command names by its Thread's handle.
 */
const root = mkdtempSync(join(tmpdir(), "mako-thread-handles-"))
const migration: Actor = { kind: "service", name: "migration" }
const numbered = (at: number) => `00000000-0000-4000-8000-${at.toString(16).padStart(12, "0")}`
const same = (thread: string) => thread

function rule(): void {
  const thread = "6b0c3c2e-5f8a-4d39-9a43-1d1b4c0f2a11"
  const code = threadCode(thread)
  assert.equal(code, "qb46rv2yf9dx", "a Thread's code is its ID's alone: this one on every device and in every build")
  assert.equal(threadCode(thread), code)
  assert.equal(code.length, HANDLE_CODE_LENGTH)
  assert.ok([...code].every((character) => HANDLE_ALPHABET.includes(character)))
  assert.equal(HANDLE_ALPHABET.length, 31)
  assert.ok(!/[01ilo]/.test(HANDLE_ALPHABET) && HANDLE_ALPHABET === HANDLE_ALPHABET.toLowerCase(), "nothing that reads as another character")
  assert.equal(threadHandle(thread, "/Users/ada/code/mako"), `mako-${code.slice(0, HANDLE_LENGTH)}`)
  assert.equal(threadHandle(thread, "/Users/ada/code/mako", 6), `mako-${code.slice(0, 6)}`, "more of its code where two share four")
  assert.equal(threadHandle(thread, "/Users/ada/code/renamed").slice(-HANDLE_LENGTH), code.slice(0, HANDLE_LENGTH), "a renamed project changes the word, never the handle")

  // Every character is as likely as any other: 31 of them over 2,000 codes, none far from 1 in 31.
  const counts = new Map<string, number>()
  for (let at = 0; at < 2_000; at++) for (const character of threadCode(numbered(at))) counts.set(character, (counts.get(character) ?? 0) + 1)
  const expected = (2_000 * HANDLE_CODE_LENGTH) / HANDLE_ALPHABET.length
  assert.equal(counts.size, HANDLE_ALPHABET.length)
  for (const [character, count] of counts) assert.ok(Math.abs(count - expected) < expected * 0.2, `${character} came up ${count} times of an expected ${Math.round(expected)}`)
}

function words(): void {
  assert.equal(handleWord("/Users/ada/code/mako"), "mako")
  assert.equal(handleWord("/Users/ada/code/mako/"), "mako", "a trailing slash is no name")
  assert.equal(handleWord("C:\\code\\Mako"), "mako", "either separator, lower case")
  assert.equal(handleWord("/code/My App (v2)"), "my-app-v2", "what isn't a letter or a digit is a hyphen, none at either end")
  assert.equal(handleWord("/code/café.tools"), "cafe-tools", "accents dropped")
  assert.equal(handleWord("/code/mako-backend-services"), "mako-backend", "cut to twelve")
  assert.equal(handleWord("/code/elevenchars-x"), "elevenchars", "and never ending on the hyphen the cut left")
  assert.equal(handleWord("/code/проект"), "thread", "a name with nothing to make a word from")
  assert.equal(handleWord(undefined), "chat", "no project")
  assert.equal(handleWord(""), "chat")
  assert.equal(handleWord("/Users/ada/Mako/Chats/2026-11-23-k3x9"), "chat", "a chat's own folder")
  assert.equal(handleWord("/Users/ada/Mako/Chats"), "chat")
  assert.equal(handleWord("/Users/ada/Mako/Chats/2026-11-23-k3x9/site"), "site", "a folder inside one is named as any other")
}

function typed(): void {
  assert.equal(handleCode("mako-7f3k"), "7f3k")
  assert.equal(handleCode("7f3k"), "7f3k", "its word is optional")
  assert.equal(handleCode("  @Mako-7F3K "), "7f3k", "any case, a mention's sigil, the space around it")
  assert.equal(handleCode("mako-backend-7f3kq2"), "7f3kq2", "the code follows the last hyphen")
  assert.equal(handleCode("7f3"), "7f3", "three characters at least")
  assert.equal(handleCode("7f"), undefined)
  assert.equal(handleCode("mako-7f3k0"), undefined, "a character outside the alphabet")
  assert.equal(handleCode("mako-7f3ki"), undefined)
  assert.equal(handleCode(`mako-${"a".repeat(HANDLE_CODE_LENGTH + 1)}`), undefined, "longer than a code")
  assert.equal(handleCode("Fix the re-auth"), undefined, "a title with a hyphen in it is no handle")
  assert.equal(handleCode("mako_x-7f3k"), undefined)
  assert.equal(handleCode(""), undefined)
  assert.equal(handleCode("-7f3k"), undefined)
  // A Thread's ID whose last group happens to be spelled in the alphabet is still an ID.
  assert.equal(handleCode("6b0c3c2e-5f8a-4d39-9a43-2d2b4c9f2a22"), undefined)
}

/** The first two numbered IDs that share four characters of their codes and part at the fifth, and one that shares only three with them. */
function collision() {
  const seen = new Map<string, string>()
  for (let at = 0; at < 200_000; at++) {
    const thread = numbered(at)
    const code = threadCode(thread)
    const earlier = seen.get(code.slice(0, HANDLE_LENGTH))
    if (earlier && threadCode(earlier)[HANDLE_LENGTH] !== code[HANDLE_LENGTH]) {
      for (let other = 0; other < 200_000; other++) {
        const near = threadCode(numbered(other))
        if (near.startsWith(code.slice(0, 3)) && near[3] !== code[3]) return { pair: [earlier, thread] as const, near: numbered(other) }
      }
    }
    seen.set(code.slice(0, HANDLE_LENGTH), thread)
  }
  throw new Error("no two of 200,000 IDs shared four characters")
}

function index(): void {
  const { pair, near } = collision()
  const [first, second] = pair
  const shared = threadCode(first).slice(0, HANDLE_LENGTH)
  assert.equal(threadCode(second).slice(0, HANDLE_LENGTH), shared, "two Threads built to share their four characters")
  const handles = new ThreadHandles()
  const others = Array.from({ length: 50 }, (_, at) => numbered(1_000_000 + at))
  handles.add([first, near, ...others])
  assert.equal(handles.size, 52)
  assert.deepEqual(handles.find(`mako-${shared}`, same), { kind: "found", thread: first }, "alone, its four characters find it")
  assert.equal(handles.length(first, same), HANDLE_LENGTH)

  handles.add([second, first])
  assert.equal(handles.size, 53, "a Thread added again is the one it was")
  const both = handles.find(`mako-${shared}`, same)
  assert.deepEqual(both, { kind: "ambiguous", threads: [{ thread: first, length: 5 }, { thread: second, length: 5 }], more: 0 }, "the two that share it, each a character longer")
  assert.deepEqual(handles.find(`other-${shared.toUpperCase()}`, same), both, "whatever word or case it was typed with")
  assert.equal(handles.length(second, same), 5)
  assert.equal(handles.length(near, same), HANDLE_LENGTH, "one that shares three of its four is told apart by the fourth")
  for (const thread of [first, second]) {
    const longer = threadHandle(thread, "/code/mako", handles.length(thread, same))
    assert.deepEqual(handles.find(longer, same), { kind: "found", thread }, `${longer} finds one`)
    assert.deepEqual(handles.find(threadCode(thread), same), { kind: "found", thread }, "and so does its whole code")
  }
  const three = handles.find(shared.slice(0, 3), same)
  assert.ok(three?.kind === "ambiguous" && three.threads.length === 3, "three characters name every Thread that starts with them")

  const absent = [..."2345"].find((start) => handles.find(`${start}${start}${start}${start}`, same)?.kind === "unknown")
  assert.ok(absent, "a handle no Thread has is unknown")
  assert.equal(handles.find("not a handle", same), undefined, "and words that aren't a handle are not looked up")

  // A Thread merged into another is found as the one it became, and the two are no collision.
  const merged = (thread: string) => (thread === second ? first : thread)
  assert.deepEqual(handles.find(shared, merged), { kind: "found", thread: first })
  assert.equal(handles.length(first, merged), HANDLE_LENGTH)
  assert.deepEqual(handles.find(shared, (thread) => (thread === first ? undefined : thread)), { kind: "found", thread: second }, "one that no longer exists is dropped")

  // More than it names: the first five, and a count of the rest.
  const crowd = new ThreadHandles()
  const start = threadCode(first).slice(0, 3)
  const alike: string[] = []
  for (let at = 0; alike.length < 7; at++) if (threadCode(numbered(at)).startsWith(start)) alike.push(numbered(at))
  crowd.add(alike)
  const many = crowd.find(start, same)
  assert.ok(many?.kind === "ambiguous" && many.threads.length === 5 && many.more === 2, JSON.stringify(many))
}

function store(): void {
  let clock = 1_000
  const journal = (): JournalFacts => ({ conversationId: randomUUID(), createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: randomUUID(), path: `/codex/${randomUUID()}` }] })
  const threads = new ThreadStore(join(root, "threads.sqlite"), { now: () => clock++ })
  try {
    const first = threads.registerJournal(journal(), migration).thread
    const code = threadCode(first)
    assert.deepEqual(threads.threadByHandle(threadHandle(first, "/code/mako")), { kind: "found", thread: first })
    assert.deepEqual(threads.threadByHandle(code.slice(0, HANDLE_LENGTH).toUpperCase()), { kind: "found", thread: first }, "without its word, in capitals")
    assert.equal(threads.threadByHandle(first), undefined, "a Thread's ID isn't a handle")
    assert.equal(threads.threadByHandle("A title, not a handle"), undefined)
    assert.equal(threads.handleLength(first), HANDLE_LENGTH)
    // Made after the index was built: found by the next lookup, with no rebuild.
    const made = Array.from({ length: 40 }, () => threads.registerJournal(journal(), migration).thread)
    for (const thread of made) {
      const found = threads.threadByHandle(threadHandle(thread, undefined, threads.handleLength(thread)))
      assert.deepEqual(found, { kind: "found", thread }, "a Thread made since is found by its handle")
    }
    const unknown = [..."2345"].map((start) => start.repeat(HANDLE_CODE_LENGTH)).find((typed) => threads.threadByHandle(typed)?.kind === "unknown")
    assert.ok(unknown, "a whole code no Thread has is unknown")
    // What `mako thread … --conversation` names: a conversation by its ID, or the newest of the Thread a handle or an ID names.
    const facts = journal()
    const placed = threads.registerJournal(facts, migration)
    assert.deepEqual(conversationNamed(threads, facts.conversationId), { conversation: facts.conversationId })
    assert.deepEqual(conversationNamed(threads, threadHandle(placed.thread, "/code/mako", threads.handleLength(placed.thread))), { conversation: facts.conversationId }, "by its Thread's handle")
    assert.deepEqual(conversationNamed(threads, placed.thread), { conversation: facts.conversationId }, "by its Thread's ID")
    assert.deepEqual(conversationNamed(threads, unknown), { conversation: unknown }, "what names nothing goes back as it came, for the command to refuse")
  } finally {
    threads.close()
  }
  // A store opened again builds the same index from its rows.
  const reopened = new ThreadStore(join(root, "threads.sqlite"), { now: () => clock++ })
  try {
    const first = reopened.registerJournal(journal(), migration).thread
    assert.deepEqual(reopened.threadByHandle(threadCode(first)), { kind: "found", thread: first })
  } finally {
    reopened.close()
  }
}

try {
  rule()
  words()
  typed()
  index()
  store()
  console.log("test:thread-handles: a handle from its Thread's ID alone, its word from the project's folder, typed handles in any case with or without the word, a collision named a character longer, unknown and merged ones, and the store's index pass")
} finally {
  rmSync(root, { recursive: true, force: true })
}
