import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { constants, zstdCompressSync } from "node:zlib"
import { VOCABULARIES } from "../dist/harnesses/index.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { statRecord } from "../dist/record-files.js"

// Each harness's `storage` declares how its records are kept. Every declared
// answer has a proof: here, against a store built for it, or in the test
// named. A new answer without a proof, or a proof for an answer no harness
// declares any more, fails.

const HERE = "record-storage.mjs"
const PROOFS = {
  "codex/zstd": HERE,
  "codex/continues": HERE,
  "codex/rewinds": "codex-records.mjs",
  "codex/copies": "fork-parents.mjs",
  "claude/branches": HERE,
  "claude/copies": "fork-parents.mjs",
  "opencode/holds-undo": HERE,
  "opencode/copies": HERE,
  "opencode/generations": HERE,
  "grok/rewinds": "../../../scripts/test-grok-store.ts",
  "grok/copies": "grok-catalog.mjs",
  "cursor/branches": HERE,
  "devin/branches": "devin-cli.mjs",
  "devin/continues": "devin-cli.mjs",
}

const testDir = dirname(fileURLToPath(import.meta.url))
const declared = VOCABULARIES.flatMap(({ harness, storage }) => [
  ...storage.encodings.filter((encoding) => encoding !== "plain").map((encoding) => `${harness}/${encoding}`),
  ...Object.keys(storage.history).map((layout) => `${harness}/${layout}`),
])
for (const answer of declared) assert.ok(PROOFS[answer], `${answer} is declared and has a proof`)
for (const [answer, file] of Object.entries(PROOFS)) {
  assert.ok(declared.includes(answer), `${answer} has a proof and is declared`)
  assert.ok(existsSync(join(testDir, file)), `${answer} is proved in ${file}, which exists`)
}
console.log(`PASS: each of ${declared.length} declared storage answers has a proof`)

const nativeStores = new NativeStores(false)
const jsonl = (values) => values.map((value) => `${JSON.stringify(value)}\n`).join("")
const shown = async (provider, path) => JSON.stringify((await provider.read(path)).entries)
const zstd = (text, contentSize = true) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_contentSizeFlag]: contentSize ? 1 : 0 } })

/** What a follower from the start shows after reading, appending, and reading again. */
async function followed(provider, path, append) {
  const follower = provider.createFollower(path, 0)
  const first = await follower.next()
  await append()
  const second = await follower.next()
  if (second.reset) return JSON.stringify(second.entries)
  if (second.replace) return JSON.stringify([...first.entries.slice(0, second.replaceFrom), ...second.entries])
  return JSON.stringify([...first.entries, ...second.entries])
}

const home = await mkdtemp(join(tmpdir(), "mako-record-storage-"))
try {
  // Codex compresses a rollout untouched for a week to .jsonl.zst in place,
  // deletes the plain file, and restores it when the thread resumes.
  const day = join(home, ".codex", "sessions", "2026", "09", "01")
  const archived = join(home, ".codex", "archived_sessions")
  await mkdir(day, { recursive: true })
  await mkdir(archived, { recursive: true })
  const at = "2026-09-01T00:00:00.000Z"
  const meta = (id, extra = {}) => ({ timestamp: at, type: "session_meta", payload: { id, cwd: "/work", timestamp: at, ...extra } })
  const event = (payload) => ({ timestamp: at, type: "event_msg", payload })
  const message = (role, type, text) => ({ timestamp: at, type: "response_item", payload: { type: "message", role, content: [{ type, text }] } })
  const turn = (prompt, answer) => [
    event({ type: "task_started", turn_id: prompt }),
    event({ type: "user_message", message: prompt }),
    message("user", "input_text", prompt),
    message("assistant", "output_text", answer),
    event({ type: "task_complete", turn_id: prompt }),
  ]
  const thread = (n) => `019a0000-0000-7000-8000-00000000000${n}`
  const rollout = (folder, id, extension, minute = "00") => join(folder, `rollout-2026-09-01T00-${minute}-00-${id}${extension}`)
  const codex = new CodexProvider(nativeStores, home)
  const listed = async () => new Map((await codex.discover()).map((file) => [file.path, file]))

  {
    const body = jsonl([meta(thread(1)), ...turn("Fix the login flow", "Fixed it.")])
    const sized = rollout(day, thread(1), ".jsonl.zst")
    const unsized = rollout(archived, thread(2), ".jsonl.zst")
    await writeFile(sized, zstd(body))
    await writeFile(unsized, zstd(body.replaceAll(thread(1), thread(2)), false))
    const plain = rollout(day, thread(3), ".jsonl")
    await writeFile(plain, body.replaceAll(thread(1), thread(3)))
    await writeFile(`${plain}.zst`, zstd(jsonl([meta(thread(3)), ...turn("A stale copy", "Stale.")])))

    for (const path of [sized, unsized]) assert.equal((await statRecord(path)).bytes, Buffer.byteLength(body), `${path} sizes in plain bytes, with or without a content size`)
    const files = await listed()
    assert.ok(files.has(sized) && files.has(unsized) && files.has(plain), "compressed rollouts list, archived ones too")
    assert.ok(!files.has(`${plain}.zst`), "a rollout in both encodings lists once, from the plain file Codex restored")
    const ref = await codex.peek(files.get(sized))
    assert.equal(ref?.nativeId, thread(1))
    assert.equal(ref.title, "Fix the login flow")
    assert.equal((await codex.peek(files.get(unsized)))?.nativeArchived, true)

    const compressed = await codex.read(sized)
    assert.ok(JSON.stringify(compressed.entries).includes("Fixed it."), "a compressed rollout shows its turns")
    assert.ok((await shown(codex, unsized)).includes("Fixed it."), "so does one without a content size")
    await writeFile(rollout(day, thread(4), ".jsonl"), body.replaceAll(thread(1), thread(4)))
    const restored = await codex.read(rollout(day, thread(4), ".jsonl"))
    assert.equal(JSON.stringify(compressed.entries).replaceAll(thread(1), thread(4)), JSON.stringify(restored.entries), "a compressed rollout reads as its plain one")
    assert.equal(compressed.checkpoint, restored.checkpoint, "and its checkpoint counts the same plain bytes")
    assert.ok((await codex.records(sized))?.files.includes(sized), "its records name the compressed file")
    console.log("PASS: Codex rollouts read alike plain, compressed with or without a content size, and archived")
  }

  // Undoing turns, or forking a thread, starts a new rollout whose
  // history_base names the rollout it continues and the byte its history ends at.
  {
    const kept = jsonl([meta(thread(5)), ...turn("First prompt", "First answer."), ...turn("Second prompt", "Second answer.")])
    const base = rollout(day, thread(5), ".jsonl")
    await writeFile(base, kept + jsonl(turn("Abandoned prompt", "Abandoned answer.")))
    const continued = (owner, rolloutId, onward) => jsonl([meta(owner, { history_base: { thread_id: rolloutId, end_byte_offset: Buffer.byteLength(kept) } }), ...onward])
    const revertId = "019a0000-0000-7000-8000-0000000000a5"
    const revert = rollout(day, `${thread(5)}_${revertId}`, ".jsonl.zst", "05")
    await writeFile(revert, zstd(continued(thread(5), thread(5), turn("After the undo", "Redone."))))
    await utimes(revert, new Date(), new Date(Date.now() + 1000))

    const files = await listed()
    assert.ok(files.has(revert) && !files.has(base), "the thread lists once, from its newest rollout")
    const after = await shown(codex, revert)
    for (const text of ["First prompt", "Second answer.", "After the undo"]) assert.ok(after.includes(text), `the revert shows ${text}`)
    assert.ok(!after.includes("Abandoned"), "and not what came after its history_base")
    assert.equal(after.indexOf("First prompt") < after.indexOf("After the undo"), true, "earlier history first")

    const follower = codex.createFollower(revert, Number.MAX_SAFE_INTEGER)
    const reset = await follower.next()
    assert.equal(reset.reset, true)
    assert.equal(JSON.stringify(reset.entries), after, "a follower that resets rereads through the earlier rollout")

    const fork = rollout(day, thread(6), ".jsonl", "06")
    await writeFile(fork, continued(thread(6), thread(5), turn("In the fork", "Forked.")))
    await assert.rejects(codex.remove(revert), /continues its history/, "a thread another continues isn't removed")
    assert.ok(existsSync(base) && existsSync(revert))
    assert.equal(await codex.remove(fork), true)
    assert.equal(await codex.remove(revert), true)
    assert.ok(!existsSync(base) && !existsSync(revert), "removing a thread removes every rollout of it, in either encoding")

    const orphan = rollout(day, thread(7), ".jsonl")
    await writeFile(orphan, continued(thread(7), thread(8), turn("Onward", "Onward.")))
    const missing = JSON.parse(await shown(codex, orphan))
    assert.equal(missing[0].label, "Earlier history missing", "a rollout whose earlier one is gone says so")
    console.log("PASS: Codex reads a rollout through the rollouts it continues, and keeps them while it does")
  }

  // Claude's rewind appends a last-prompt naming the message the
  // conversation continues from; what came after it was abandoned.
  {
    const folder = join(home, ".claude", "projects", "-work")
    await mkdir(folder, { recursive: true })
    const session = "33333333-3333-4333-8333-333333333333"
    const path = join(folder, `${session}.jsonl`)
    const base = { sessionId: session, cwd: "/work", timestamp: at }
    const user = (uuid, parentUuid, text) => ({ ...base, type: "user", uuid, parentUuid, message: { role: "user", content: text } })
    const assistant = (uuid, parentUuid, text) => ({
      ...base, type: "assistant", uuid, parentUuid,
      message: { id: `msg-${uuid}`, role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text }], stop_reason: "end_turn" },
    })
    const rewind = (leafUuid) => ({ type: "last-prompt", leafUuid, explicit: true, rewound: true, sessionId: session })
    const lines = [user("u1", null, "Kept prompt"), assistant("a1", "u1", "Kept answer."), user("u2", "a1", "Abandoned prompt"), assistant("a2", "u2", "Abandoned answer.")]
    await writeFile(path, jsonl(lines))
    const claude = new ClaudeProvider(home)
    const onward = [rewind("a1"), user("u3", "a1", "After the rewind"), assistant("a3", "u3", "Rewound.")]
    const live = await followed(claude, path, () => appendFile(path, jsonl(onward)))
    const after = await shown(claude, path)
    assert.ok(after.includes("Kept answer.") && after.includes("After the rewind"))
    assert.ok(!after.includes("Abandoned"), "a rewind drops what came after the message it names")
    assert.equal(live, after, "a follower that saw the abandoned turn drops it as the rewind arrives")

    await appendFile(path, jsonl([{ type: "last-prompt", leafUuid: "00000000-0000-0000-0000-000000000000", explicit: true, sessionId: session }, user("u4", "a3", "Later prompt")]))
    const cleared = await shown(claude, path)
    assert.ok(cleared.startsWith(after.slice(0, -1)) && cleared.includes("Later prompt"), "clearing the leaf keeps everything")
    console.log("PASS: Claude reads the branch its rewind continues")
  }

  // OpenCode's /undo stages a revert on the session, kept until the next
  // prompt deletes the messages; a v1 store migrated to v2 keeps both tables.
  {
    const root = join(home, ".local", "share", "opencode")
    await mkdir(root, { recursive: true })
    const dbPath = join(root, "opencode.db")
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER, revert TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER, revert TEXT, fork_session_id TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT INTO project VALUES ('p', '/work', 'work', 1, 1);
    `)
    const json = JSON.stringify
    const v2 = (id, updated, { revert = null, fork = null } = {}) =>
      db.prepare("INSERT INTO session_v2 VALUES (?, 'p', NULL, '/work', ?, NULL, 1000, ?, NULL, ?, ?)").run(id, `Session ${id}`, updated, revert && json(revert), fork)
    const v2Message = (session, seq, type, text) => db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      `${session}-m${seq}`, session, type, seq, 1000 + seq, 1000 + seq,
      type === "user"
        ? json({ text, files: [], agents: [], time: { created: 1000 + seq } })
        : json({ agent: "build", content: [{ type: "text", text }], finish: "stop", time: { created: 1000 + seq, completed: 1000 + seq } }),
    )
    const v1 = (id, updated, revert = null) =>
      db.prepare("INSERT INTO session VALUES (?, 'p', NULL, '/work', ?, 1000, ?, NULL, ?)").run(id, `Session ${id}`, updated, revert && json(revert))
    const v1Message = (session, n, role, parts) => {
      const id = `${session}-m${n}`
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, 1000 + n, 1000 + n, json({ role, time: { created: 1000 + n, completed: 1000 + n } }))
      parts.forEach((text, index) => db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`${id}-p${index}`, id, session, 1000 + n, 1000 + n, json({ type: "text", text })))
    }

    v2("ses_undo", 2000, { revert: { messageID: "ses_undo-m3", snapshot: "s", files: [] } })
    v2Message("ses_undo", 1, "user", "Kept prompt")
    v2Message("ses_undo", 2, "assistant", "Kept answer.")
    v2Message("ses_undo", 3, "user", "Undone prompt")
    v2Message("ses_undo", 4, "assistant", "Undone answer.")
    v1("ses_v1undo", 2000, { messageID: "ses_v1undo-m2", partID: "ses_v1undo-m2-p1" })
    v1Message("ses_v1undo", 1, "user", ["Kept prompt"])
    v1Message("ses_v1undo", 2, "assistant", ["Kept part.", "Undone part."])
    v1Message("ses_v1undo", 3, "user", ["Undone prompt"])
    v2("ses_fork", 3000, { fork: "ses_undo" })
    v2Message("ses_fork", 1, "user", "Kept prompt")
    for (const [id, v1At, v2At] of [["ses_v1newer", 5000, 4000], ["ses_v2newer", 4000, 5000], ["ses_tied", 4000, 4000]]) {
      v1(id, v1At)
      v1Message(id, 1, "user", ["From v1"])
      v2(id, v2At)
      v2Message(id, 1, "user", "From v2")
    }
    db.close()

    const openCode = new OpenCodeProvider(nativeStores, home)
    const path = (id, current) => `${dbPath}#${current ? "v2:" : ""}${id}`
    const undone = await shown(openCode, path("ses_undo", true))
    assert.ok(undone.includes("Kept answer.") && !undone.includes("Undone prompt") && !undone.includes("Undone answer."), "a staged revert hides the messages from its own on")
    assert.ok(undone.includes("2 undone messages"), "and says how many OpenCode holds")
    const partly = await shown(openCode, path("ses_v1undo", false))
    assert.ok(partly.includes("Kept part.") && !partly.includes("Undone part.") && !partly.includes("Undone prompt"), "a v1 revert inside a message keeps the parts before it")

    const files = new Map((await openCode.discover()).map((file) => [file.path, file]))
    assert.equal((await openCode.peek(files.get(path("ses_fork", true))))?.parentNativeId, "ses_undo", "a v2 fork names its source")
    assert.ok(files.has(path("ses_v1newer", false)) && !files.has(path("ses_v1newer", true)), "a session in both generations lists from the one written last")
    assert.ok(files.has(path("ses_v2newer", true)) && !files.has(path("ses_v2newer", false)))
    assert.ok(files.has(path("ses_tied", false)) && !files.has(path("ses_tied", true)), "a tie lists the v1 copy a migration wrote whole")
    console.log("PASS: OpenCode hides a staged revert, names a fork's source, and lists each session from one generation")
  }

  // Cursor keeps every state of the conversation as a root blob listing its
  // turns; meta's latestRootBlobId names the current one.
  {
    const id = "44444444-4444-4444-8444-444444444444"
    const folder = join(home, ".cursor", "acp-sessions", id)
    await mkdir(folder, { recursive: true })
    const path = join(folder, "store.db")
    const db = new DatabaseSync(path)
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    const turn = (n, text) => {
      const hash = Buffer.alloc(32, n)
      db.prepare("INSERT INTO blobs VALUES (?, ?)").run(hash.toString("hex"), Buffer.from(JSON.stringify({ role: "user", content: [{ type: "text", text: `<user_query>${text}</user_query>` }] })))
      return hash
    }
    const root = (blob, turns) => db.prepare("INSERT INTO blobs VALUES (?, ?)").run(blob, Buffer.concat(turns.flatMap((hash) => [Buffer.from([10, 32]), hash])))
    const kept = turn(1, "Kept prompt")
    root("earlier", [kept, turn(2, "Abandoned prompt")])
    root("latest", [kept, turn(3, "After the edit")])
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: id, latestRootBlobId: "latest" }))
    db.close()
    await writeFile(join(folder, "meta.json"), JSON.stringify({ cwd: home, updatedAtMs: 1_000 }))
    const after = await shown(new CursorProvider(nativeStores, home, {}), path)
    assert.ok(after.includes("Kept prompt") && after.includes("After the edit"))
    assert.ok(!after.includes("Abandoned"), "an earlier root's turns are an earlier state, not the conversation")
    console.log("PASS: Cursor reads the root its meta names")
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
