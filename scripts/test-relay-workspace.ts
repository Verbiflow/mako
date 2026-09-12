import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { stageRelayAttachments } from "../electron/relay-artifacts.ts"
import { openRelayLog, relayJobRef } from "../electron/relay-log.ts"
import { describeRelayPresence } from "../electron/relay-status.ts"
import {
  RelayWorkspaceError,
  describeRelayWorkspace,
  findRelayProject,
  isScratchPath,
  rankRelayProjects,
  resolveRelayWorkspace,
} from "../electron/relay-workspace.ts"

// The installed app starts with process.cwd() === "/", and the first real
// relay job died with `ENOENT: mkdir '/.mako-relay-…'`. Nothing here may
// resolve to a scratch path, and the home directory is the last resort.
// The system temp directory is itself a scratch path, so the fixture lives
// under the real home directory for the length of the run.
await mkdir(join(homedir(), ".cache", "mako-fixtures"), { recursive: true })
const root = await mkdtemp(
  join(homedir(), ".cache", "mako-fixtures", "relay-workspace-")
)
const home = join(root, "home")
const projects = {
  ui: join(home, "code", "pi-ui"),
  api: join(home, "code", "pi-api"),
  docs: join(home, "writing", "docs"),
}
for (const path of [home, ...Object.values(projects)])
  await mkdir(path, { recursive: true })

try {
  assert.ok(isScratchPath("/"))
  assert.ok(isScratchPath("/tmp/x"))
  assert.ok(isScratchPath("/private/tmp/mako-fixture"))
  assert.ok(isScratchPath("/var/folders/ab/T/mako-fixture"))
  assert.ok(!isScratchPath(projects.ui))

  const ranked = rankRelayProjects(
    [
      { cwd: projects.api, at: "2026-09-01T00:00:00.000Z" },
      { cwd: `${projects.ui}/`, at: "2026-09-10T00:00:00.000Z" },
      { cwd: projects.ui, at: "2026-09-02T00:00:00.000Z" },
      { cwd: "/", at: "2026-09-11T00:00:00.000Z" },
      { cwd: "/tmp/mako-fixture", at: "2026-09-11T00:00:00.000Z" },
      { cwd: home, at: "2026-09-11T00:00:00.000Z" },
      { cwd: undefined, at: "2026-09-11T00:00:00.000Z" },
      { cwd: projects.docs },
    ],
    { home }
  )
  assert.deepEqual(
    ranked.map((project) => project.path),
    [projects.ui, projects.api, projects.docs],
    "newest first, deduplicated, without scratch paths or home"
  )
  assert.equal(ranked[0]?.name, "pi-ui")

  assert.equal(findRelayProject(projects.api, ranked)?.path, projects.api)
  assert.equal(findRelayProject("pi-api", ranked)?.path, projects.api)
  assert.equal(findRelayProject("PI-API", ranked)?.path, projects.api)
  assert.equal(findRelayProject("docs", ranked)?.path, projects.docs)
  assert.equal(findRelayProject("pi", ranked), undefined, "ambiguous fragment")
  assert.equal(findRelayProject("nothing", ranked), undefined)

  const selected = await resolveRelayWorkspace({
    selected: projects.api,
    threadCwd: projects.ui,
    recent: () => [{ cwd: projects.docs, at: "2026-09-11T00:00:00.000Z" }],
    home,
  })
  assert.deepEqual(selected, { cwd: projects.api, source: "selected" })
  assert.equal(describeRelayWorkspace(selected), "in pi-api")

  await assert.rejects(
    resolveRelayWorkspace({
      selected: join(root, "missing"),
      recent: () => [],
      home,
    }),
    RelayWorkspaceError,
    "an explicit project that is gone is an error, not a silent fallback"
  )

  const thread = await resolveRelayWorkspace({
    threadCwd: projects.ui,
    recent: () => [{ cwd: projects.docs, at: "2026-09-11T00:00:00.000Z" }],
    home,
  })
  assert.deepEqual(thread, { cwd: projects.ui, source: "thread" })

  const goneThread = await resolveRelayWorkspace({
    threadCwd: join(root, "deleted-thread-cwd"),
    recent: () => [{ cwd: projects.docs, at: "2026-09-11T00:00:00.000Z" }],
    home,
  })
  assert.deepEqual(
    goneThread,
    { cwd: projects.docs, source: "recent" },
    "a deleted thread directory falls through to recent work"
  )
  assert.equal(
    describeRelayWorkspace(goneThread),
    "in docs, your most recent project"
  )

  const fallback = await resolveRelayWorkspace({
    recent: () => [
      { cwd: "/", at: "2026-09-11T00:00:00.000Z" },
      { cwd: "/tmp/mako-fixture-x", at: "2026-09-11T00:00:00.000Z" },
    ],
    home,
  })
  assert.deepEqual(
    fallback,
    { cwd: home, source: "home" },
    "process.cwd() and fixture directories never become the workspace"
  )

  // Attachments stage under Mako's asset root; the workspace only receives
  // the outbound manifest directory, and both disappear on cleanup.
  const assetRoot = join(root, "remote-assets")
  const staged = await stageRelayAttachments(
    {
      kind: "new",
      forceNew: false,
      attachments: [],
      origin: {
        provider: "slack",
        tenantId: "T",
        conversationId: "C",
        threadId: "1.2",
        eventId: "e",
        userId: "U",
      },
      selection: {},
      text: "hello",
    },
    { assetRoot, cwd: projects.ui, deviceId: "device", jobId: "job-1" }
  )
  assert.equal(
    staged.manifestPath,
    join(projects.ui, ".mako-relay", "job-1", "outbound-files.json")
  )
  assert.ok((await stat(join(assetRoot, "job-1", "inbox"))).isDirectory())
  assert.deepEqual(await readdir(projects.ui), [".mako-relay"])
  await staged.cleanup()
  assert.deepEqual(await readdir(projects.ui), [], "nothing left in the repo")
  // Only the inbox goes: the conversation keeps its own copies beside it.
  await assert.rejects(stat(join(assetRoot, "job-1", "inbox")))

  const now = Date.parse("2026-09-11T12:00:00.000Z")
  const base = {
    deviceId: "device",
    startedAt: "2026-09-11T11:00:00.000Z",
    lastPollAt: "2026-09-11T11:59:57.000Z",
    lastLeaseAt: null,
    lastCompletionAt: null,
    nextPollAt: "2026-09-11T12:00:20.000Z",
    consecutiveFailures: 0,
    jobsCompleted: 0,
    currentJob: null,
    lastFailure: null,
  }
  assert.equal(
    describeRelayPresence(
      {
        kind: "worker",
        deviceName: "studio",
        status: { ...base, phase: "waiting", jobsCompleted: 2 },
        workspace: "pi-ui",
      },
      now
    ),
    "Relay listening as studio · checked 3s ago · 2 jobs completed · new requests run in pi-ui"
  )
  assert.equal(
    describeRelayPresence(
      {
        kind: "worker",
        deviceName: "studio",
        status: {
          ...base,
          phase: "backoff",
          consecutiveFailures: 3,
          lastFailure: {
            at: "2026-09-11T11:59:58.000Z",
            phase: "lease",
            message: "lease returned 401",
          },
        },
        workspace: null,
      },
      now
    ),
    "Relay failing: lease — lease returned 401 (3 attempts, retrying in 20s)"
  )
  assert.equal(
    describeRelayPresence({ kind: "disabled", reason: "the dev profile" }),
    "Relay off: the dev profile"
  )

  // The on-disk log: one line per entry, multi-line messages folded, job refs
  // short and stable, and rotation once the file passes its budget.
  const logPath = join(root, "logs", "relay.log")
  const log = openRelayLog(logPath, {
    maxBytes: 160,
    now: () => new Date("2026-09-11T20:00:00.000Z"),
  })
  log.info("worker listening")
  log.warn("job 29ba3a8f-0000-4000-8000-000000000000 failed: line one\nline two")
  await log.flush()
  const first = await readFile(logPath, "utf8")
  assert.equal(
    first,
    "2026-09-11T20:00:00.000Z info worker listening\n2026-09-11T20:00:00.000Z warn job 29ba3a8f-0000-4000-8000-000000000000 failed: line one line two\n"
  )
  log.info("a".repeat(80))
  await log.flush()
  assert.equal(await readFile(`${logPath}.1`, "utf8"), first)
  assert.match(await readFile(logPath, "utf8"), /^2026-09-11T20:00:00.000Z info a{80}\n$/)
  assert.equal(relayJobRef("29ba3a8f-0000-4000-8000-000000000000"), "29ba3a8f")
  console.log("relay workspace resolution, staging, presence, and log checks passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
