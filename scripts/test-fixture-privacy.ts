import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describeLeaks, FIXTURE_FOLDERS, leaksIn, machineIdentity, rewriteBlob, scrubIdentity, scrubJsonLines, scrubTree, STAND_INS, treeLeaks, type Identity } from "./fixture-privacy.ts"

const ana: Identity[] = [
  { kind: "home", pattern: /\/Users\/ana/g, standIn: STAND_INS.home },
  { kind: "email", pattern: /ana@corp\.test/gi, standIn: STAND_INS.email },
  { kind: "host", pattern: /Ana-MacBook/gi, standIn: STAND_INS.host },
  { kind: "user", pattern: /\bana\b/gi, standIn: STAND_INS.user },
]

assert.equal(
  scrubIdentity('{"serverName":"Ana-MacBook.local","text":"drwx  ana  staff  /Users/ana/project ana@corp.test"}', ana),
  '{"serverName":"mako-pair-host.local","text":"drwx  mako  staff  /Users/mako/project mako@example.invalid"}',
  "the host goes before the user it contains, and each value has its stand-in",
)
assert.equal(scrubIdentity("a banana for Anabel", ana), "a banana for Anabel", "a user name is replaced only as a word")
assert.deepEqual(leaksIn("ls shows Ana as owner", ana), ["machine user"], "a user name in another case still leaks")

assert.deepEqual(leaksIn("Co-Authored-By: Claude <noreply@anthropic.com>, docs@example.com, mako@example.invalid", ana), [], "a harness's no-reply sender and documentation domains are fine")
assert.deepEqual(leaksIn("mail someone@gmail.com", ana), ["email"])
assert.deepEqual(leaksIn("/Users/me/project /home/user/x /home/ubuntu/repos/project /Users/admin/actions-runner/_work /Users/mako/a", ana), [], "placeholders and vendor build paths are fine")
assert.deepEqual(leaksIn("/Users/bob/Library/x", ana), ["home path"])
assert.deepEqual(leaksIn("/Users/admin/secrets/x", ana), ["home path"], "only xAI's build runner is allowed under admin")
assert.deepEqual(leaksIn(`key sk-ant-${"a".repeat(24)}`, ana), ["token"])

const root = await mkdtemp(join(tmpdir(), "mako-fixture-privacy-"))
try {
  await writeFile(join(root, "capture.jsonl"), '{"serverName":"Ana-MacBook.local"}\n')
  await writeFile(join(root, "image.png"), Buffer.from("binary bytes, no identity"))
  const database = new DatabaseSync(join(root, "store.db"))
  database.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT, raw BLOB, n INTEGER)")
  database.prepare("INSERT INTO rows (body, raw, n) VALUES (?, ?, ?)").run("owner ana in /Users/ana/x", null, 7)
  database.prepare("INSERT INTO rows (body, raw, n) VALUES (?, ?, ?)").run("nothing here", null, 8)
  database.close()

  assert.deepEqual((await treeLeaks(root, ana)).map(({ kinds }) => kinds), [["machine host", "machine user"], ["home path", "machine home", "machine user"]])
  assert.equal((await scrubTree(root, ana)).length, 2, "the capture and the store are rewritten, the image is left alone")
  assert.deepEqual(await treeLeaks(root, ana), [])
  const scrubbed = new DatabaseSync(join(root, "store.db"), { readOnly: true })
  assert.deepEqual(scrubbed.prepare("SELECT body, n FROM rows ORDER BY id").all().map((row) => ({ ...row })), [{ body: "owner mako in /Users/mako/x", n: 7 }, { body: "nothing here", n: 8 }])
  scrubbed.close()
  assert.deepEqual(await scrubTree(root, ana), [], "scrubbing again changes nothing")

  const blob = new DatabaseSync(join(root, "store.db"))
  blob.prepare("UPDATE rows SET raw = ? WHERE id = 2").run(Buffer.from('{"role":"user","content":"cached for Ana-MacBook"}'))
  blob.close()
  assert.deepEqual((await treeLeaks(root, ana)).map(({ kinds }) => kinds), [["machine host", "machine user"]], "a blob that holds text is checked")
  assert.deepEqual(await scrubTree(root, ana), [join(root, "store.db")], "and rewritten")
  assert.deepEqual(await treeLeaks(root, ana), [])
} finally {
  await rm(root, { recursive: true, force: true })
}

// A Cursor step: field 3 (thinking_message) holding field 1 (text) and field 2 (a duration).
const step = (text: string) => {
  const body = Buffer.from(text)
  const thinking = Buffer.concat([Buffer.from([0x0a, body.length]), body, Buffer.from([0x10, 0x07])])
  return Buffer.concat([Buffer.from([0x1a, thinking.length]), thinking])
}
const toStandIn = (text: string) => scrubIdentity(text, ana)
assert.deepEqual(rewriteBlob(step("reading /Users/ana/notes.md"), toStandIn), step("reading /Users/mako/notes.md"), "a protobuf's strings are rewritten and every length around them encoded again")
const before = `${"x".repeat(116)} /Users/ana`
assert.deepEqual(
  rewriteBlob(Buffer.concat([Buffer.from([0x0a, 127]), Buffer.from(before)]), toStandIn),
  Buffer.concat([Buffer.from([0x0a, 0x80, 0x01]), Buffer.from(toStandIn(before))]),
  "a length of 127 that grows to 128 takes two bytes",
)
const untouched = step("nothing to replace")
assert.equal(rewriteBlob(untouched, toStandIn), untouched, "a value with nothing to replace is the same value")
const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01])
assert.equal(rewriteBlob(bytes, toStandIn), bytes, "bytes that are neither protobuf nor text are left alone")

const delta = (text: string) => JSON.stringify({ message: { delta: { type: "text-delta", text } } })
const thinking = (text: string) => JSON.stringify({ message: { delta: { type: "thinking-delta", text } } })
const streamed = [delta("see `/Use"), thinking("/Users/a"), delta("rs/ana/x` and /Users/a"), delta("na"), delta("/y"), JSON.stringify({ turn: "t" })].join("\n")
assert.deepEqual(
  scrubJsonLines(`${streamed}\n`, ana).split("\n").filter(Boolean),
  [delta("see `/Users/mako"), thinking("/Users/a"), delta("/x` and /Users/mako"), delta(""), delta("/y"), JSON.stringify({ turn: "t" })],
  "a match split across a stream's fragments is written whole where it starts and cut from the rest; another stream's fragments don't join it",
)
const streamRoot = await mkdtemp(join(tmpdir(), "mako-fixture-privacy-"))
try {
  await writeFile(join(streamRoot, "capture.jsonl"), `${streamed}\n`)
  assert.deepEqual((await treeLeaks(streamRoot, ana)).map(({ kinds }) => kinds), [["home path", "machine home", "machine user"]], "a name only a stream read whole shows still leaks")
  assert.deepEqual(await scrubTree(streamRoot, ana), [join(streamRoot, "capture.jsonl")])
  assert.deepEqual(await treeLeaks(streamRoot, ana), [])
  const events = new DatabaseSync(join(streamRoot, "index.db"))
  events.exec("CREATE TABLE run_events (seq INTEGER, payload_json TEXT)")
  const insert = events.prepare("INSERT INTO run_events VALUES (?, ?)")
  streamed.split("\n").forEach((line, seq) => insert.run(seq, line))
  events.close()
  assert.deepEqual((await treeLeaks(streamRoot, ana)).map(({ kinds }) => kinds), [["home path", "machine home", "machine user"]], "a column of JSON rows streams like JSON Lines")
  assert.deepEqual(await scrubTree(streamRoot, ana), [join(streamRoot, "index.db")])
  const rows = new DatabaseSync(join(streamRoot, "index.db"), { readOnly: true })
  assert.deepEqual(rows.prepare("SELECT payload_json AS line FROM run_events ORDER BY seq").all().map((row) => row["line"]), scrubJsonLines(scrubIdentity(streamed, ana), ana).split("\n"), "each row is rewritten as its line in the stream, as a JSON Lines file is")
  rows.close()
  assert.deepEqual(await treeLeaks(streamRoot, ana), [])
} finally {
  await rm(streamRoot, { recursive: true, force: true })
}
assert.equal(scrubJsonLines("not json\n/Users/ana", ana), "not json\n/Users/ana", "a text that isn't JSON Lines is left to the plain scrub")

const identity = machineIdentity()
const leaks = (await Promise.all(FIXTURE_FOLDERS.map((folder) => treeLeaks(folder, identity)))).flat()
assert.equal(leaks.length, 0, `fixtures identify someone; run \`npx tsx scripts/fixture-privacy.ts --scrub\` and check what's left (values not printed):\n${describeLeaks(leaks)}`)

console.log(`PASS: no published fixture names the recording machine (${identity.map(({ kind }) => kind).join(", ")}), an address, a home folder or a token`)
