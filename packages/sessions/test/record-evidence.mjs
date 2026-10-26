import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { gzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { WriterEvidenceReader, cursorAgentDay } from "../dist/record-evidence.js"
import { npmReleaseTimeline, readReleaseTimelines, releaseBound, writeReleaseTimeline } from "../dist/record-releases.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { EVIDENCE_RULES, outdatedOf, outdatedText, restoreGate, writersOf } from "../dist/record-writers.js"
import { compareVersions } from "../dist/runtime-version.js"

/**
 * Which build wrote a session that states none and that Mako never saw run,
 * from what each harness leaves beside its store (recorded shapes, scrubbed:
 * no conversation, no credentials): Devin's per-launch logs, Devin.app's
 * launch logs, Grok's unified log and npm's release dates, `cursor-agent`'s
 * versions folder and day-named builds, Cursor's launch logs, Mako's pins
 * of the SDK, and every install on PATH. What "newer" means between a
 * `cursor-agent` build and the SDK, held to the fields each declares. Then the gate's policy for what that
 * leaves: a known writer, a range's upper bound, or nothing, where only an
 * install provably newer is let through. And the backfill's step that reads a
 * session's own records back from the store for a version captured before
 * the rule.
 */

const DAY = 24 * 60 * 60 * 1000
const at = (iso) => Date.parse(iso)
const root = await mkdtemp(join(tmpdir(), "mako-record-evidence-"))
const home = join(root, "home")
const bin = join(root, "bin")
await mkdir(bin, { recursive: true })
const touch = async (path, iso) => utimes(path, new Date(iso), new Date(iso))
const reader = (extra = {}) => new WriterEvidenceReader({ home, readings: join(root, "readings.json"), path: [bin], cache: join(root, "cache"), ...extra })
try {
  // Devin CLI: a session row, and logs naming it with each process's version.
  {
    const dir = join(home, ".local", "share", "devin", "cli")
    await mkdir(join(dir, "logs"), { recursive: true })
    const db = new DatabaseSync(join(dir, "sessions.db"))
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL)")
    const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?)")
    insert.run("palm-science", at("2026-10-15T14:40:00Z") / 1000, at("2026-10-15T14:46:00Z") / 1000)
    insert.run("quiet-heron", at("2026-10-15T15:00:00Z") / 1000, at("2026-10-15T15:01:00Z") / 1000)
    insert.run("old-badger", at("2026-08-01T00:00:00Z") / 1000, at("2026-08-02T00:00:00Z") / 1000)
    db.close()
    const log = (version, lines) => [
      `2026-10-15T14:40:49.000000Z  INFO init_cli: chisel: version=${version} commit=deb81600 os=macos arch=aarch64 binary=devin startup`,
      `2026-10-15T14:40:49.100000Z  INFO run_acp_server: chisel_agent::process_memory: session DB inventory at boot: newest_visible_ids[3]=quiet-heron,old-badger`,
      ...lines,
    ].join("\n") + "\n"
    await writeFile(join(dir, "logs", "devin_20261015-074049_84107.log.gz"), gzipSync(log("3000.10.20", [
      "2026-10-15T14:40:50.000000Z  INFO chisel_agent::session_db: Created new session: palm-science",
    ])))
    await writeFile(join(dir, "logs", "devin_20261015-074500_9.log"), log("3000.10.23", [
      "2026-10-15T14:45:00.000000Z  INFO load_session: chisel_agent::acp_server::agent_impl: ACP: loading session palm-science",
      "2026-10-15T14:45:10.000000Z  INFO chisel_agent::session_db: Saved 9 message nodes (starting from 12) for session palm-science",
    ]))
    const path = (id) => `${join(dir, "sessions.db")}#${id}`
    const named = await reader({ binaries: { devin: [] } }).devinCli(path("palm-science"))
    assert.equal(named.source, "log")
    assert.deepEqual(named.versions, ["3000.10.20", "3000.10.23"], "each process that created, loaded or saved it, oldest first")
    assert.deepEqual(named.writes, { first: at("2026-10-15T14:40:00Z"), last: at("2026-10-15T14:46:00Z") })
    assert.equal(writersOf({ record: [], observed: [], evidence: named }).at(-1).version, "3000.10.23")
    const inventoryOnly = await reader({ binaries: { devin: [] } }).devinCli(path("quiet-heron"))
    assert.equal(inventoryOnly.source, "unknown", "a session a log only lists at boot isn't one it wrote")
    // The install: Devin.app's CLI, whose version the host read off it unchanged.
    const app = join(root, "Devin.app-cli")
    await writeFile(app, "#!/bin/sh\n")
    await touch(app, "2026-09-10T00:00:00Z")
    const { statSync } = await import("node:fs")
    const info = statSync(app)
    await writeFile(join(root, "readings.json"), JSON.stringify({ version: 2, updates: {}, signatures: { devin: { binary: app, mtimeMs: info.mtimeMs, size: info.size, installed: "3000.10.23" } } }))
    const installed = await reader({ binaries: { devin: [app] } }).devinCli(path("quiet-heron"))
    assert.deepEqual([installed.source, installed.versions], ["install", ["3000.10.23"]], "the only install, there unchanged since before the session's first write")
    const before = await reader({ binaries: { devin: [app] } }).devinCli(path("old-badger"))
    assert.equal(before.source, "unknown", "a session written before the install was put there")
    assert.match(before.why, /known only from/)
    // A second install on PATH whose version nothing names: no install is trusted.
    await writeFile(join(bin, "devin"), "#!/bin/sh\n")
    const ambiguous = await reader({ binaries: { devin: [app] } }).devinCli(path("quiet-heron"))
    assert.equal(ambiguous.source, "unknown")
    assert.match(ambiguous.why, /version of .*devin.* isn't known/)
    await rm(join(bin, "devin"))

    // Devin.app: each launch's log names the CLI it spawned, the same unchanged binary the host read.
    const devinApp = join(root, "Devin")
    const messages = join(devinApp, "User", "acp-messages")
    await mkdir(messages, { recursive: true })
    const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()
    const launch = async (stamp, spawned) => {
      const folder = join(devinApp, "logs", stamp, "window1", "exthost", "codeium.windsurf")
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, "Devin ACP.log"), [
        "2026-09-11 20:46:04.270 [info] acp feature flags (provisional, awaiting auth): acpCustom=false",
        ...spawned ? [`2026-09-11 20:46:05.009 [info] [devin-cli] Spawning process: ${spawned} acp`, `2026-09-11 20:46:05.010 [info] [summary-agent] Spawning process: ${spawned} acp --agent-type summarizer`] : [],
      ].join("\n") + "\n")
    }
    await launch("20260911T204556", app)
    await launch("20260911T204755", app)
    await launch("20260913T215707", null)
    const session = async (name, from, to) => {
      const file = join(messages, `${name}.db`)
      await writeFile(file, "")
      // A modification time before its birth moves the birth back (APFS), then the last write.
      await utimes(file, new Date(from), new Date(from))
      await utimes(file, new Date(to), new Date(to))
      return file
    }
    const appSession = await session("0c1a4697", local(2026, 9, 11, 20, 49), local(2026, 9, 11, 20, 51))
    const fromApp = await reader().devinApp(appSession)
    assert.deepEqual([fromApp.source, fromApp.versions], ["install", ["3000.10.23"]], "every launch while it was written spawned Devin.app's CLI, unchanged since")
    assert.match(fromApp.why, /Devin\.app launch/)
    const across = await session("8f1767c1", local(2026, 9, 11, 20, 49), local(2026, 9, 14, 9, 0))
    assert.equal((await reader().devinApp(across)).source, "unknown", "a launch whose log names no CLI ran while it was written")
    const early = await session("955ea1fe", local(2026, 9, 1, 0, 0), local(2026, 9, 11, 20, 51))
    // Only a filesystem that moves a file's birth back (APFS) can make one first written before the oldest launch log.
    if ((await stat(early)).birthtimeMs <= local(2026, 9, 1, 0, 0)) assert.match((await reader().devinApp(early)).why, /launch logs .* begin/, "written before the oldest launch log")
    else console.log("skipped: this filesystem keeps a file's birth, so no session can be made older than its launch logs")
  }

  // Grok: its unified log names a session and each process's version.
  {
    const grok = join(home, ".grok")
    const folder = join(grok, "sessions", "%2Fwork", "a6d6d943-0055-4cd1-82c1-f039e4637096")
    await mkdir(folder, { recursive: true })
    await mkdir(join(grok, "logs"), { recursive: true })
    await writeFile(join(folder, "summary.json"), JSON.stringify({ info: { id: "a6d6d943-0055-4cd1-82c1-f039e4637096" }, created_at: "2026-10-17T10:40:00.000Z" }))
    await writeFile(join(folder, "updates.jsonl"), "{}\n")
    await touch(join(folder, "updates.jsonl"), "2026-10-17T10:50:00Z")
    await touch(join(folder, "summary.json"), "2026-10-17T10:50:00Z")
    await writeFile(join(grok, "logs", "unified.jsonl"), [
      { ts: "2026-10-17T10:43:03.199Z", src: "shell", pid: 60339, ver: "1.0.62", lvl: "info", msg: "agent initialized" },
      { ts: "2026-10-17T10:43:04.000Z", src: "shell", pid: 60339, ver: "1.0.62", lvl: "info", msg: "session.setup.phase", ctx: { method: "session/load", phase: "auth", sessionId: "a6d6d943-0055-4cd1-82c1-f039e4637096" } },
      { ts: "2026-10-17T10:43:05.000Z", src: "shell", pid: 51111, ver: "1.0.46", lvl: "info", msg: "session.setup.phase", ctx: { method: "session/new", phase: "auth", sessionId: null } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n")
    const logged = await reader().grokSession(join(folder, "updates.jsonl"))
    assert.deepEqual([logged.source, logged.versions], ["log", ["1.0.62"]])
    // Without the log: Grok's versioned builds in `bin/` and an npm install on PATH, both 1.0.46 throughout.
    await writeFile(join(grok, "logs", "unified.jsonl"), "")
    await mkdir(join(grok, "bin"), { recursive: true })
    await writeFile(join(grok, "bin", "grok-1.0.46"), "binary")
    await touch(join(grok, "bin", "grok-1.0.46"), "2026-10-05T22:27:16Z")
    await symlink(join(grok, "bin", "grok-1.0.46"), join(bin, "grok-link"))
    const pkg = join(root, "npm", "lib", "node_modules", "@xai-official", "grok")
    await mkdir(join(pkg, "bin"), { recursive: true })
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@xai-official/grok", version: "1.0.46" }))
    await writeFile(join(pkg, "bin", "grok-native"), "binary")
    await touch(join(pkg, "bin", "grok-native"), "2026-10-05T22:27:16Z")
    await symlink(join(pkg, "bin", "grok-native"), join(bin, "grok"))
    const installed = await reader().grokSession(join(folder, "updates.jsonl"))
    assert.deepEqual([installed.source, installed.versions], ["install", ["1.0.46"]], "every install, Grok's own and npm's, held 1.0.46")
    // A newer build put in `bin/` while the session was being written: two versions could have written it.
    await writeFile(join(grok, "bin", "grok-1.0.62"), "binary")
    await touch(join(grok, "bin", "grok-1.0.62"), "2026-10-17T10:45:00Z")
    const straddled = await reader().grokSession(join(folder, "updates.jsonl"))
    assert.equal(straddled.source, "unknown")
    assert.match(straddled.why, /held .* and .*hasn't read its release dates/)
    // npm's release dates bound it: the newest version published by a day after its last write, by version, not by date.
    const packument = { name: "@xai-official/grok", time: { created: "2025-10-22T05:02:25.858Z", modified: "2026-10-17T08:37:23.984Z", "1.0.46": "2026-09-30T22:11:16.129Z", "1.0.62": "2026-10-16T16:53:47.482Z", "1.0.45-alpha.1": "2026-10-17T09:00:00.000Z", "1.0.63": "2026-10-18T12:00:00.000Z", "1.0.64": "2026-10-19T08:00:00.000Z" } }
    const timeline = npmReleaseTimeline("@xai-official/grok", packument, at("2026-10-19T09:00:00Z"))
    assert.deepEqual(timeline.releases.map((release) => release.version), ["1.0.46", "1.0.62", "1.0.45-alpha.1", "1.0.63", "1.0.64"], "every version, prereleases too, by date; created and modified aren't versions")
    writeReleaseTimeline(join(root, "cache"), "npm:@xai-official/grok", timeline)
    assert.deepEqual(readReleaseTimelines(join(root, "cache"))["npm:@xai-official/grok"], timeline, "kept beside the other evidence")
    const bounded = await reader().grokSession(join(folder, "updates.jsonl"))
    assert.deepEqual([bounded.source, bounded.bound, bounded.upTo], ["range", "releases", "1.0.62"], "1.0.63 came out more than a day after the last write; an older line's later prerelease doesn't count as newer")
    assert.match(bounded.why, /newest @xai-official\/grok npm had published/)
    assert.equal(restoreGate({ record: [], observed: [], evidence: bounded }, "1.0.62").kind, "same-or-newer", "an install at the bound reads it")
    assert.equal(restoreGate({ record: [], observed: [], evidence: bounded }, "1.0.46").kind, "unproven")
    const early = npmReleaseTimeline("@xai-official/grok", packument, at("2026-10-18T00:00:00Z"))
    assert.deepEqual(releaseBound(early, at("2026-10-17T10:50:00Z")).ok, false, "a timeline read before the margin's end may lack a newer release")
    assert.match(releaseBound(undefined, 0).why, /hasn't read/)
  }

  // cursor-agent: its versions folder, and builds named by their day.
  {
    const versions = join(home, ".local", "share", "cursor-agent", "versions")
    for (const name of ["2026.09.28-64d2043", "2026.10.01-e373342", "2026.10.14-0f9edde"]) await mkdir(join(versions, name), { recursive: true })
    const chat = join(home, ".cursor", "chats", "68cb518f", "39fc58cb-7793-4e80-b5d1-343da0f42fea")
    await mkdir(chat, { recursive: true })
    const db = new DatabaseSync(join(chat, "store.db"))
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: "39fc58cb", createdAt: Date.now() + 1_000 })).toString("hex"))
    db.close()
    const evidence = await reader().cursorStore(join(chat, "store.db"))
    // Folders made now: every one was born before the chat's first write; the newest is the only install over its writes.
    assert.equal(evidence.line, "cursor-agent")
    assert.deepEqual([evidence.source, evidence.versions], ["install", ["2026.10.14-0f9edde"]])
    assert.equal(await reader().cursorSdkAgent(join(home, ".mako", "cursor-sdk", "agents", "agent-x", "store.db")), null, "an SDK agent with no store has nothing to read")
    // Mako's own SDK agents: the newest SDK Mako's repository had pinned by the last write.
    const agent = join(home, ".mako", "cursor-sdk", "agents", "agent-y")
    await mkdir(agent, { recursive: true })
    const agentDb = new DatabaseSync(join(agent, "store.db"))
    agentDb.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    agentDb.close()
    await touch(join(agent, "store.db"), "2026-10-01T12:00:00Z")
    const pinned = await reader().cursorSdkAgent(join(agent, "store.db"))
    assert.deepEqual([pinned.source, pinned.bound, pinned.upTo], ["range", "pins", "1.0.31"])
    assert.match(pinned.why, /not proof of the build that ran/)
    assert.equal(restoreGate({ record: [], observed: [], evidence: pinned }, "1.0.31").kind, "same-or-newer", "the SDK Mako ships reads what it pinned")
    await touch(join(agent, "store.db"), "2026-09-01T12:00:00Z")
    assert.equal((await reader().cursorSdkAgent(join(agent, "store.db"))).source, "unknown", "an agent from before the repository pinned an SDK")
    // The SDK's agents are Mako's wherever its user root is: an isolated host's under its data root, which `cursorStore` doesn't take for a `cursor-agent` store.
    const isolated = join(home, "isolated-root", "cursor-sdk", "agents", "agent-z")
    await mkdir(isolated, { recursive: true })
    await cp(join(agent, "store.db"), join(isolated, "store.db"))
    await touch(join(isolated, "store.db"), "2026-10-01T12:00:00Z")
    const provider = new CursorProvider(new NativeStores(true), home, join(home, "isolated-root"))
    assert.equal((await provider.writerEvidence(join(isolated, "store.db"), reader())).bound, "pins", "an isolated host's SDK agent reads as Mako's own")
    assert.equal(await reader().cursorStore(join(isolated, "store.db")), null)
    // An older chat, from before any kept build: only its day bounds the build that wrote it.
    const old = join(home, ".cursor", "chats", "68cb518f", "11111111-7793-4e80-b5d1-343da0f42fea")
    await mkdir(old, { recursive: true })
    const oldDb = new DatabaseSync(join(old, "store.db"))
    oldDb.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    oldDb.close()
    await touch(join(old, "store.db"), "2026-08-18T12:00:00Z")
    const ranged = await new WriterEvidenceReader({ home, path: [bin], cache: null }).cursorStore(join(old, "store.db"))
    assert.equal(ranged.source, "range")
    assert.equal(ranged.upTo, cursorAgentDay(at("2026-08-19T12:00:00Z")))
    assert.equal(ranged.upTo, "2026.08.19")
    assert.equal(ranged.bound, "build-day")
  }

  // Cursor's editor: each launch's log names the version that ran.
  {
    const user = join(root, "Cursor")
    await mkdir(join(user, "User", "globalStorage"), { recursive: true })
    const db = new DatabaseSync(join(user, "User", "globalStorage", "state.vscdb"))
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    const local = (y, mo, d, h) => new Date(y, mo - 1, d, h).getTime()
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:c1", JSON.stringify({ _v: 18, createdAt: local(2026, 9, 8, 12), lastUpdatedAt: local(2026, 9, 8, 13) }))
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:c2", JSON.stringify({ _v: 18, createdAt: local(2026, 9, 8, 0), lastUpdatedAt: local(2026, 9, 8, 13) }))
    db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run("composerData:c3", JSON.stringify({ _v: 3, createdAt: local(2026, 8, 1, 0), lastUpdatedAt: local(2026, 8, 1, 1) }))
    db.close()
    for (const [name, version] of [["20260907T030350", "3.17.8"], ["20260908T010319", "3.19.16"], ["20260908T025641", "3.20.0"]]) {
      await mkdir(join(user, "logs", name), { recursive: true })
      await writeFile(join(user, "logs", name, "main.log"), `2026-09-08 00:00:26.213 [info] updateURL https://api2.cursor.sh/updates/api/update/darwin-arm64/cursor/${version}/abc/dev\n`)
    }
    const database = join(user, "User", "globalStorage", "state.vscdb")
    const one = await reader().cursorStore(`${database}#composer:c1`)
    assert.deepEqual([one.source, one.versions], ["install", ["3.20.0"]], "written only while 3.20.0 ran")
    const two = await reader().cursorStore(`${database}#composer:c2`)
    assert.equal(two.source, "unknown", "written across a restart into a new version")
    const three = await reader().cursorStore(`${database}#composer:c3`)
    assert.equal(three.source, "unknown", "written before the oldest launch log kept")
  }

  // The policy: a known writer, a range's upper bound, and nothing.
  {
    const writes = { first: at("2026-10-15T00:00:00Z"), last: at("2026-10-15T01:00:00Z") }
    const unknown = { record: [], observed: [], evidence: { source: "unknown", writes, why: "fixture", at: 0 } }
    assert.equal(restoreGate(unknown, "3000.10.23").kind, "unproven", "nothing names the writer: gated")
    assert.equal(restoreGate(unknown, { version: "3000.10.23", since: writes.first - DAY, sole: true }).kind, "same-or-newer", "the only install, put there before the first write and unchanged since")
    assert.equal(restoreGate(unknown, { version: "3000.10.23", since: writes.first - DAY, sole: false }).kind, "unproven", "another install could have written it")
    assert.equal(restoreGate(unknown, { version: "3000.10.23", since: writes.first + 1, sole: true }).kind, "unproven", "installed after the first write")
    assert.equal(restoreGate(unknown, null).kind, "unknown", "an install whose version can't be read blocks nothing")
    const range = { record: [], observed: [], evidence: { source: "range", line: "cursor-agent", upTo: "2026.10.16", writes, why: "fixture", at: 0 } }
    const cursor = (agent) => ({ version: "1.0.31", ...agent && { lines: { "cursor-agent": { version: agent, sole: true } } } })
    assert.equal(restoreGate(range, cursor("2026.10.16-aaa")).kind, "unproven", "a build of the bound's day itself may be older than the writer's")
    assert.equal(restoreGate(range, cursor("2026.10.17-aaa")).kind, "same-or-newer", "a build after the bound is newer than any possible writer")
    const missing = restoreGate(range, cursor(null))
    assert.deepEqual(missing, { kind: "unproven", installed: null, line: "cursor-agent", upTo: "2026.10.16", evidence: "range" })
    assert.equal(outdatedText("Cursor", outdatedOf(missing)), "Mako can't tell which cursor-agent version wrote this session; it may have been as new as 2026.10.16, and no cursor-agent is installed here.")
    assert.equal(outdatedText("Devin", outdatedOf(restoreGate(unknown, "3000.10.23"))), "Mako can't tell which Devin version wrote this session, so it can't show that Devin 3000.10.23 here reads it.")
    const logged = { record: [], observed: [], evidence: { source: "log", versions: ["3000.10.20", "3000.10.23"], writes, why: "fixture", at: 0 } }
    assert.equal(restoreGate(logged, "3000.10.22").kind, "older", "a log names the writer; the newest it names counts")
  }

  // What "newer" means between a cursor-agent build and the SDK that imports its stores: made after the day npm published the SDK.
  // Held to the fields each one's code declares for the store's messages (`scripts/cursor-store-fields.ts`): no build made by an
  // SDK's publication day writes a field that SDK lacks, other than fields a later build dropped.
  {
    const fields = JSON.parse(readFileSync(new URL("./fixtures/cursor-store-fields.json", import.meta.url), "utf8"))
    const builds = Object.keys(fields.builds).sort(compareVersions)
    const dropped = (build) => new Set(Object.entries(fields.builds[build]).flatMap(([message, numbers]) => numbers.filter((number) => builds.some((later) => compareVersions(later, build) > 0 && !fields.builds[later][message]?.includes(number))).map((number) => `${message}.${number}`)))
    let reads = 0
    for (const [version, sdk] of Object.entries(fields.sdk)) {
      const day = cursorAgentDay(Date.parse(sdk.published))
      for (const build of builds) {
        const lacks = Object.entries(fields.builds[build]).flatMap(([message, numbers]) => numbers.filter((number) => !sdk.fields[message]?.includes(number)).map((number) => `${message}.${number}`)).filter((field) => !dropped(build).has(field))
        const gate = restoreGate({ record: [], observed: [], evidence: { source: "install", versions: [build], line: "cursor-agent", why: "fixture", at: 0 } }, { version, lines: { "cursor-agent": { version: day, reader: `SDK ${version}` } } })
        if (gate.kind !== "same-or-newer") continue
        reads += 1
        assert.deepEqual(lacks, [], `SDK ${version} (published ${day}) lets in cursor-agent ${build}, which writes fields it lacks`)
      }
    }
    assert.ok(reads >= 10, `the rule lets builds through on the recorded pairs (${reads})`)
  }

  // A pass looks again at what earlier rules, or release dates read since, may now name.
  {
    const store = new RecordStore(join(root, "records-revisit"), new NativeStores(false))
    const path = join(root, "revisit.jsonl")
    await writeFile(path, "{}\n")
    const records = { roots: [{ name: "root", path: root }], files: [path], databases: [] }
    for (const id of ["old-rules", "unknown", "ranged"]) await store.capture({ harness: "grok", nativeId: id, home: root, records, path })
    const later = Date.now() + 60_000
    await store.noteEvidence("grok", "old-rules", { source: "range", upTo: "1.0.46", why: "x", at: later })
    await store.noteEvidence("grok", "unknown", { source: "unknown", why: "x", at: later, rules: EVIDENCE_RULES })
    await store.noteEvidence("grok", "ranged", { source: "range", upTo: "1.0.46", why: "x", at: later, rules: EVIDENCE_RULES })
    assert.deepEqual(store.sessionsWithoutWriters().map((session) => session.nativeId).sort(), ["old-rules"], "evidence from older rules is looked at again")
    assert.deepEqual(store.sessionsWithoutWriters({ unknownBefore: later + 1 }).map((session) => session.nativeId).sort(), ["old-rules", "unknown"], "nothing found before newer release dates were read: looked at again")
    await store.close()
  }

  // The backfill's step: versions a session's own records state, read from the store for a capture taken before the rule.
  {
    const claudeHome = join(root, "claude-home")
    const project = join(claudeHome, ".claude", "projects", "-work")
    await mkdir(project, { recursive: true })
    const id = "6676d8e9-0576-43d4-9858-31fe4b22cd29"
    const path = join(project, `${id}.jsonl`)
    await writeFile(path, `${JSON.stringify({ type: "user", sessionId: id, version: "2.1.295", message: { role: "user", content: "hi" } })}\n`)
    const stores = new NativeStores(false)
    const provider = new ClaudeProvider(claudeHome, stores)
    const store = new RecordStore(join(root, "records"), stores)
    const records = await provider.records(path)
    // As a build before the rule took it: no writer.
    await store.capture({ harness: "claude", nativeId: id, home: claudeHome, records: { ...records, writer: undefined }, path })
    assert.deepEqual(store.sessionsWithoutWriters().map((session) => session.nativeId), [id])
    assert.deepEqual(await store.rescanWriters("claude", id, provider.recordWriter), ["2.1.295"])
    assert.deepEqual(store.writers("claude", id), { record: ["2.1.295"], observed: [] })
    assert.deepEqual(store.sessionsWithoutWriters(), [], "nothing left to look for")
    await store.noteEvidence("claude", "nobody", { source: "unknown", why: "x", at: Date.now() })
    await store.close()
  }
  console.log("record evidence: Devin's, Devin.app's and Grok's logs, cursor-agent's and Grok's installs, Cursor's launches, npm's release dates, the day bound, Mako's pins, the SDK against cursor-agent's fields, the policy, the revisit, the rescan")
} finally {
  await rm(root, { recursive: true, force: true })
}
