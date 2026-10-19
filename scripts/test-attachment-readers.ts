import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { browserFamily, DeskClients, NOTE_EVERY_MS, readDeskClients } from "@mako/host/base/desk-clients"
import { LiveAssets } from "@mako/host/conversations/live-assets"
import { spawn } from "node:child_process"
import { attachmentReaders, firefoxOrigin } from "../packages/host/src/threads/attachment-readers.ts"
import { AttachmentSweep } from "../packages/sessions/src/attachment-sweep.ts"

/**
 * Where the attachments' sweep reads from (`attachment-readers.ts`): every
 * Mako profile's folders, those outside app data the session ledger names,
 * every Chromium-family profile's localStorage and Firefox's per-origin
 * stores for loopback origins; a browser whose storage can't be read holds
 * what existed while a desk ran there (`desk-clients.ts`), and before the
 * record began every staged file is held. A reused `LiveAssets` file starts
 * its times again, so the sweep's grace covers the prompt that reused it.
 * Fixture folders only.
 */

const root = mkdtempSync(join(tmpdir(), "mako-attachment-readers-"))
const safari = join(root, "home", "Library", "Containers", "com.apple.Safari", "Data", "Library", "WebKit", "WebsiteData", "Default")
try {
  const home = join(root, "home")
  const appData = join(home, "Library", "Application Support")
  const folder = (...parts: string[]) => {
    const path = join(...parts)
    mkdirSync(path, { recursive: true })
    return path
  }
  for (const name of ["mako", "mako-dev", "mako-dev-ui-desk", "makeover", "Other App"]) folder(appData, name)
  const outside = folder(root, "elsewhere", "fixture-profile")
  folder(root, "elsewhere", "fixture-profile-ui-agent-views")
  const ledger = join(home, ".mako", "session-memory.sqlite")
  folder(home, ".mako")
  const db = new DatabaseSync(ledger)
  db.exec("CREATE TABLE runtime_hosts (socket TEXT PRIMARY KEY, launch TEXT NOT NULL)")
  db.prepare("INSERT INTO runtime_hosts VALUES (?, ?)").run("/tmp/a.sock", JSON.stringify({ dataRoot: outside }))
  db.prepare("INSERT INTO runtime_hosts VALUES (?, ?)").run("/tmp/b.sock", "not json")
  db.close()
  // A Chromium-family browser by its `Local State`, whatever its name, with two profiles.
  const chrome = folder(appData, "Vendor", "Browser")
  writeFileSync(join(chrome, "Local State"), JSON.stringify({ browser: { first_run_finished: true }, profile: { info_cache: { Default: {}, "Profile 1": {} } } }))
  folder(chrome, "Default", "Local Storage", "leveldb")
  folder(chrome, "Profile 1", "Local Storage", "leveldb")
  // Firefox: a loopback origin's store and another site's.
  const profile = folder(appData, "Firefox", "Profiles", "abc.default")
  for (const origin of ["http+++127.0.0.1+5173", "http+++fix.thread.localhost+5174^userContextId=1", "https+++example.com"]) {
    folder(profile, "storage", "default", origin, "ls")
    const store = new DatabaseSync(join(profile, "storage", "default", origin, "ls", "data.sqlite"))
    store.exec("CREATE TABLE data (key TEXT PRIMARY KEY, compression_type INTEGER, value BLOB)")
    store.close()
  }
  // Readable here, so a read would find it: Safari's container must never be listed (macOS asks the person each time).
  folder(safari, "salt", "http_127.0.0.1_5173", "LocalStorage")
  writeFileSync(join(safari, "salt", "http_127.0.0.1_5173", "LocalStorage", "localstorage.sqlite3"), "")

  const input = { appData, app: "mako", dataRoot: join(appData, "mako-dev"), sessionMemory: ledger, home, platform: "darwin" as const }
  const before = Date.now()
  const found = await attachmentReaders(input)
  assert.deepEqual(found.roots, [join(appData, "mako"), join(appData, "mako-dev"), join(appData, "mako-dev-ui-desk"), outside, join(root, "elsewhere", "fixture-profile-ui-agent-views")].sort(), "every profile and client folder, in app data and outside it, and nothing else")
  assert.deepEqual(found.browsers.filter((store) => store.kind === "chromium").map((store) => store.label).sort(), ["Browser Default", "Browser Profile 1"])
  assert.deepEqual(found.browsers.filter((store) => store.kind === "firefox").map((store) => store.path.split("/").at(-3)).sort(), ["http+++127.0.0.1+5173", "http+++fix.thread.localhost+5174^userContextId=1"], "only Firefox's loopback origins")
  assert.equal(firefoxOrigin("http+++127.0.0.1+5173"), "http://127.0.0.1:5173")
  assert.equal(firefoxOrigin("https+++example.com"), "https://example.com")
  assert.ok(!found.browsers.some((store) => store.path.includes("com.apple.Safari")), "Safari's container is never read")
  assert.equal(found.holds.length, 1, "Safari isn't read, but nothing says a desk ran there")
  assert.deepEqual(found.holds[0]!.kinds, ["staged"])
  assert.ok(found.holds[0]!.through >= before, "with no record, every staged file there is now is held")

  // The launcher notes each browser family, at most every five minutes, merged with what other launchers wrote.
  assert.equal(browserFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"), "safari")
  assert.equal(browserFamily("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0"), "chromium")
  assert.equal(browserFamily("Mozilla/5.0 (Macintosh; rv:133.0) Gecko/20100101 Firefox/133.0"), "firefox")
  assert.equal(browserFamily("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Mako/0.0.1 Chrome/138.0 Electron/38.0 Safari/537.36"), "electron")
  assert.equal(browserFamily(undefined), "other")
  let clock = Date.now()
  const path = join(home, ".mako", "desk-clients.json")
  const launcher = new DeskClients(path, () => clock)
  const safariAgent = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
  launcher.note(safariAgent, "http://127.0.0.1:5173")
  await launcher.settled()
  const first = await readDeskClients(path)
  assert.ok(first?.browsers.safari, "the first call is noted")
  const since = first.since
  clock += 1_000
  launcher.note(safariAgent, "http://127.0.0.1:5173")
  await launcher.settled()
  assert.equal((await readDeskClients(path))?.browsers.safari?.lastSeen, first.browsers.safari!.lastSeen, "a call within five minutes isn't written")
  const other = new DeskClients(path, () => clock)
  other.note("Mozilla/5.0 Chrome/131.0 Safari/537.36", "http://localhost:5180")
  await other.settled()
  const merged = await readDeskClients(path)
  assert.ok(merged?.browsers.safari && merged.browsers.chromium, "another launcher's note keeps the first's")
  assert.equal(merged.since, since)

  // A desk known to have run in Safari, which can't be read: everything that existed then is held, of every kind.
  const recorded = await attachmentReaders({ ...input, now: clock + 60_000 })
  const safariHold = recorded.holds.find((hold) => hold.why.includes("safari"))
  assert.ok(safariHold, JSON.stringify(recorded.holds))
  assert.deepEqual(safariHold.kinds, ["archive", "live", "staged"])
  assert.equal(safariHold.through, merged.browsers.safari!.lastSeen + NOTE_EVERY_MS, "up to its last note and the time a note may wait")
  assert.equal(recorded.holds.find((hold) => hold.kinds.length === 1)?.through, since, "staged files from before the record began stay held")
  assert.ok(!recorded.holds.some((hold) => hold.why.includes("chromium")), "a browser that's read holds nothing")

  // A profile whose running host is a build that doesn't restart a reused file's times: its LiveAssets wait; once the host is gone they're swept.
  {
    // Without the Safari record above, whose hold would name the file first.
    rmSync(path)
    const profileRoot = join(appData, "mako-dev")
    const liveFolder = folder(profileRoot, "conversations", "assets")
    const stale = join(liveFolder, "0f6c2b7e-0000-4000-8000-00000000000d-old.png")
    writeFileSync(stale, "an old prompt's file nothing names")
    const old = new Date(Date.now() - 3 * 60 * 60_000)
    utimesSync(stale, old, old)
    const older = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    try {
      // The host holds the data root's lock (its pid in `host.lock`) and its ledger row has no `liveAssetsTouch`.
      writeFileSync(join(profileRoot, "host.lock"), `${older.pid}\n`)
      const ledgerDb = new DatabaseSync(ledger)
      ledgerDb.prepare("INSERT INTO runtime_hosts VALUES (?, ?)").run("/tmp/dev.sock", JSON.stringify({ dataRoot: profileRoot, executable: "x", args: [], cwd: "/", profile: "dev" }))
      ledgerDb.close()
      const readers = () => attachmentReaders(input)
      const waiting = await readers()
      const hold = waiting.holds.find((entry) => entry.root === profileRoot)
      assert.ok(hold && hold.kinds.join() === "live", JSON.stringify(waiting.holds))
      assert.match(hold.why, new RegExp(`mako-dev's running host \\(pid ${older.pid}\\) is a build that doesn't restart`))
      const sweep = new AttachmentSweep({ archive: join(home, ".mako", "archive"), shared: join(home, ".mako"), readers, graceMs: 1_000 })
      const control = { stopped: () => false, yieldToPerson: async () => {} }
      const held = await sweep.pass(control, { sweep: true })
      assert.equal(held.folders["live mako-dev"]?.held.files, 1, "the older host's profile isn't swept")
      assert.ok(held.owners[hold.why], "and the readout says why")
      assert.ok(statSync(stale).isFile())
      // The same host, of a build that restarts a reused file's times, holds nothing.
      const updated = new DatabaseSync(ledger)
      updated.prepare("UPDATE runtime_hosts SET launch = ? WHERE socket = ?").run(JSON.stringify({ dataRoot: profileRoot, executable: "x", args: [], cwd: "/", profile: "dev", liveAssetsTouch: true }), "/tmp/dev.sock")
      updated.close()
      assert.ok(!(await readers()).holds.some((entry) => entry.root === profileRoot), "a build that restarts the times holds nothing")
      const back = new DatabaseSync(ledger)
      back.prepare("UPDATE runtime_hosts SET launch = ? WHERE socket = ?").run(JSON.stringify({ dataRoot: profileRoot, executable: "x", args: [], cwd: "/", profile: "dev" }), "/tmp/dev.sock")
      back.close()
    } finally {
      older.kill()
    }
    await new Promise((done) => older.once("exit", done))
    // Past the grace that setting its times started (a change time can't be set back).
    await new Promise((done) => setTimeout(done, 1_100))
    const gone = await attachmentReaders(input)
    assert.ok(!gone.holds.some((entry) => entry.root === profileRoot), "once the older host is gone nothing holds the folder")
    const sweep = new AttachmentSweep({ archive: join(home, ".mako", "archive"), shared: join(home, ".mako"), readers: () => attachmentReaders(input), graceMs: 1_000 })
    const swept = await sweep.pass({ stopped: () => false, yieldToPerson: async () => {} }, { sweep: true })
    assert.equal(swept.folders["live mako-dev"]?.trashed.files, 1, `and the sweep takes what nothing names: ${JSON.stringify({ folder: swept.folders["live mako-dev"], holds: swept.holds, stopped: swept.stopped, ran: swept.ran, unreadable: swept.unreadable })}`)
    assert.ok(statSync(join(`${liveFolder}-trash`, "0f6c2b7e-0000-4000-8000-00000000000d-old.png")).isFile())
  }

  // LiveAssets reusing a file by its hash starts its times again.
  const assets = new LiveAssets(join(root, "assets"))
  const [first0] = assets.retainPrompt([{ name: "shot.png", mimeType: "image/png", data: Buffer.from("same bytes").toString("base64") }])
  const kept = first0!.path!
  const old = new Date(Date.now() - 3 * 60 * 60_000)
  utimesSync(kept, old, old)
  assets.retainPrompt([{ name: "shot.png", mimeType: "image/png", data: Buffer.from("same bytes").toString("base64") }])
  assert.ok(Date.now() - statSync(kept).mtimeMs < 60_000, "a reused file's grace starts again")
  console.log("PASS: every profile, client and browser store a desk's drafts may be in, the holds for those that can't be read, and a reused file's times")
} finally {
  chmodSync(safari, 0o755)
  rmSync(root, { recursive: true, force: true })
}
