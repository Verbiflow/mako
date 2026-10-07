import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describeLeaks, FIXTURE_FOLDERS, leaksIn, machineIdentity, scrubIdentity, scrubTree, STAND_INS, treeLeaks, type Identity } from "./fixture-privacy.ts"

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
  blob.prepare("UPDATE rows SET raw = ? WHERE id = 2").run(Buffer.from("cached for Ana-MacBook"))
  blob.close()
  assert.deepEqual((await treeLeaks(root, ana)).map(({ kinds }) => kinds), [["machine host", "machine user"]], "a blob that holds text is checked, though only text is rewritten")
} finally {
  await rm(root, { recursive: true, force: true })
}

const identity = machineIdentity()
const leaks = (await Promise.all(FIXTURE_FOLDERS.map((folder) => treeLeaks(folder, identity)))).flat()
assert.equal(leaks.length, 0, `fixtures identify someone; run \`npx tsx scripts/fixture-privacy.ts --scrub\` and check what's left (values not printed):\n${describeLeaks(leaks)}`)

console.log(`PASS: no published fixture names the recording machine (${identity.map(({ kind }) => kind).join(", ")}), an address, a home folder or a token`)
