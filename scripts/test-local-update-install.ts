import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { installerControls } from "../electron/local-update-install.js"
import { basename } from "node:path"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bundleProcessIds,
  completeLocalInstall,
  daemonProcessIds,
  desktopLaunchEnvironment,
  GRANTS_RESET_MESSAGE,
  MAKO_BUNDLE_ID,
  parseDesignatedRequirement,
  pruneRetainedApplications,
  reconcileGrantIdentity,
  replacePreparedApplication,
  runningBundleProcesses,
  stopBundleBrowserHosts,
  type LocalInstallReceipt,
} from "../electron/local-update-installer.js"

const root = await mkdtemp(join(tmpdir(), "mako-install-test-"))
async function fixture(name: string) {
  const staging = join(root, name, "stage")
  const target = join(root, name, "Mako.app")
  await mkdir(join(staging, "Mako.app"), { recursive: true })
  await mkdir(target)
  await writeFile(join(target, "identity"), "old")
  await writeFile(join(staging, "Mako.app/identity"), "new")
  return { staging, target, ready: async () => {} }
}
try {
  const stopped: number[] = []
  await stopBundleBrowserHosts("/Applications/Mako.app", async (command, args) => ({
    stdout: command === "lsof"
      ? `p${args[2]}\nftxt\nn${args[2] === "51" ? "/Applications/Mako.app" : "/other/Mako.app"}/Contents/Frameworks/Mako Helper.app/Contents/MacOS/Mako Helper\n`
      : args.includes("-axo") ? "51 mako-browser-host\n52 mako-browser-host\n53 Mako\n" : "mako-browser-host\n",
    stderr: "",
  }), (pid) => { stopped.push(pid) })
  assert.deepEqual(stopped, [51], "only a browser helper executing from the target bundle may be stopped")
  const success = await fixture("success")
  const backup = await replacePreparedApplication({
    ...success,
    verify: async (path) => {
      assert.equal(await readFile(join(path, "identity"), "utf8"), "new")
    },
  })
  assert.equal(await readFile(join(success.target, "identity"), "utf8"), "new")
  assert.ok(backup)
  assert.equal(await readFile(join(backup, "identity"), "utf8"), "old")
  const rollback = await fixture("rollback")
  await mkdir(join(rollback.staging, "Failed Mako.app"))
  await writeFile(join(rollback.staging, "Failed Mako.app/keep"), "retained")
  await assert.rejects(
    replacePreparedApplication({
      ...rollback,
      verify: async (path) => {
        if (path === rollback.target) throw new Error("Changed signature")
      },
    }),
    /Changed signature/
  )
  assert.equal(await readFile(join(rollback.target, "identity"), "utf8"), "old")
  const failedDirectory = (await readdir(rollback.staging)).find((name) =>
    name.startsWith("failed-")
  )
  assert.ok(failedDirectory)
  assert.equal(
    await readFile(
      join(rollback.staging, failedDirectory, "Mako.app/identity"),
      "utf8"
    ),
    "new"
  )
  assert.equal(
    await readFile(join(rollback.staging, "Failed Mako.app/keep"), "utf8"),
    "retained"
  )
  const changed = await fixture("changed-during-verification")
  await assert.rejects(
    replacePreparedApplication({
      ...changed,
      verify: async (path) => {
        if (path !== join(changed.staging, "Mako.app")) return
        await rename(changed.target, join(root, "externally-moved.app"))
        await mkdir(changed.target)
        await writeFile(join(changed.target, "identity"), "concurrent app")
      },
    }),
    /changed/
  )
  assert.equal(
    await readFile(join(changed.target, "identity"), "utf8"),
    "concurrent app"
  )
  const rejected = await fixture("rejected")
  await assert.rejects(
    replacePreparedApplication({
      ...rejected,
      verify: async () => {
        throw new Error("Untrusted signer")
      },
    }),
    /Untrusted/
  )
  assert.equal(await readFile(join(rejected.target, "identity"), "utf8"), "old")
  const link = join(root, "linked.app")
  await symlink(rejected.target, link)
  await assert.rejects(
    replacePreparedApplication({
      ...rejected,
      target: link,
      verify: async () => {},
    }),
    /regular application/
  )
  const blocked = await fixture("became-busy")
  await assert.rejects(
    replacePreparedApplication({
      ...blocked,
      verify: async () => {},
      ready: async () => {
        throw new Error("Mako started")
      },
    }),
    /Mako started/
  )
  assert.equal(await readFile(join(blocked.target, "identity"), "utf8"), "old")
  const concurrent = await fixture("concurrent")
  let entered = () => {}
  const verificationEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const firstInstall = replacePreparedApplication({
    ...concurrent,
    verify: async (path) => {
      if (path.includes("stage")) {
        entered()
        await held
      }
    },
  })
  await verificationEntered
  try {
    await assert.rejects(
      replacePreparedApplication({ ...concurrent, verify: async () => {} }),
      /Another installer/
    )
  } finally {
    release()
  }
  await firstInstall
  const fresh = await fixture("fresh")
  await rename(fresh.target, join(root, "unused.app"))
  assert.equal(
    await replacePreparedApplication({ ...fresh, verify: async () => {} }),
    null
  )
  const receipts: LocalInstallReceipt[] = []
  await assert.rejects(
    completeLocalInstall({
      replace: async () => "/retained/old.app",
      save: async (receipt) => {
        receipts.push(receipt)
      },
      launch: async () => {
        throw new Error("Launch failed")
      },
    }),
    /Launch failed/
  )
  assert.equal(receipts.at(-1)?.ok, true)
  assert.match(receipts.at(-1)?.message ?? "", /installed.*could not reopen/)
  receipts.length = 0
  let prunedUnverified = false
  await assert.rejects(completeLocalInstall({
    replace: async () => "/retained/old.app",
    save: async (receipt) => { receipts.push(receipt) },
    launch: async () => {}, // macOS accepted open, but the app never started.
    verifyStarted: async () => { throw new Error("The host reported a different build.") },
    prune: async () => { prunedUnverified = true },
  }), /different build/)
  assert.deepEqual(receipts[0], { ok: true, backup: "/retained/old.app", startup: "pending" })
  assert.equal(receipts.at(-1)?.ok && receipts.at(-1)?.startup, "failed")
  assert.equal(prunedUnverified, false)
  receipts.length = 0
  const order: string[] = []
  await completeLocalInstall({
    replace: async () => "/retained/old.app",
    save: async (receipt) => { receipts.push(receipt); order.push(receipt.ok ? receipt.startup ?? "installed" : "failed") },
    launch: async () => { order.push("open") },
    verifyStarted: async () => { order.push("probe") },
    prune: async () => { order.push("prune") },
  })
  assert.deepEqual(order, ["pending", "open", "probe", "verified", "prune"])
  receipts.length = 0
  await assert.rejects(
    completeLocalInstall({
      replace: async () => {
        throw new Error("Verification failed")
      },
      save: async (receipt) => {
        receipts.push(receipt)
      },
      launch: async () => {},
    }),
    /Verification failed/
  )
  assert.deepEqual(receipts, [{ ok: false, message: "Verification failed" }])
  const titles =
    "12 /Applications/Mako.app/Contents/MacOS/Mako\n13 Mako\n14 Mako Helper (Renderer)\n15 AnotherApp\n16 mako-terminal-daemon\n17 mako-syncd"
  assert.deepEqual(bundleProcessIds(titles, "/Applications/Mako.app"), [12, 13, 14])
  assert.deepEqual(daemonProcessIds(titles), [16, 17])
  const receiptsForPrune: LocalInstallReceipt[] = []
  const pruned: Array<string | null> = []
  await completeLocalInstall({
    replace: async () => "/retained/newest/Previous Mako.app",
    save: async (receipt) => {
      receiptsForPrune.push(receipt)
    },
    launch: async () => {},
    prune: async (backup) => {
      pruned.push(backup)
      throw new Error("Housekeeping failure must not change the receipt")
    },
  })
  assert.deepEqual(pruned, ["/retained/newest/Previous Mako.app"])
  assert.deepEqual(receiptsForPrune, [{ ok: true, backup: "/retained/newest/Previous Mako.app" }])
  // Retained copies: only the newest survives, and only pure backups are removed.
  const applications = join(root, "Applications")
  const installed = join(applications, "Mako.app")
  await mkdir(installed, { recursive: true })
  const retained = async (name: string, contents: string[]) => {
    const staging = join(applications, name)
    for (const entry of contents) {
      await mkdir(join(staging, entry), { recursive: true })
      await writeFile(join(staging, entry, "identity"), entry)
    }
    return staging
  }
  const newest = await retained(".mako-update-newest1", ["Previous Mako.app"])
  const older = await retained(".mako-update-older01", ["Previous Mako.app"])
  const cli = await retained(".mako-local-install-old2", ["Previous Mako.app"])
  await writeFile(join(cli, "installer.mjs"), "")
  const inFlight = await retained(".mako-update-inflight", ["Mako.app", "Previous Mako.app"])
  const failed = await retained(".mako-update-failed01", ["Previous Mako.app", "failed-abc"])
  const foreign = await retained("Other.app", ["Contents"])
  const linked = join(applications, ".mako-update-linked1")
  await symlink(older, linked)
  const removed = await pruneRetainedApplications(installed, join(newest, "Previous Mako.app"))
  assert.deepEqual(removed.sort(), [cli, older].sort())
  assert.deepEqual(
    (await readdir(applications)).sort(),
    [".mako-update-failed01", ".mako-update-inflight", ".mako-update-linked1", ".mako-update-newest1", "Mako.app", "Other.app"].sort()
  )
  assert.ok(await readFile(join(inFlight, "Mako.app/identity"), "utf8"), "a staging directory with a candidate is untouched")
  assert.ok(await readFile(join(failed, "failed-abc/identity"), "utf8"), "rollback evidence is untouched")
  assert.ok(await readFile(join(foreign, "Contents/identity"), "utf8"))
  await writeFile(`${installed}.update-lock`, "{}")
  assert.deepEqual(await pruneRetainedApplications(installed, null), [], "no pruning while another installer holds the lock")
  await rm(`${installed}.update-lock`)
  assert.deepEqual(await pruneRetainedApplications(installed, null), [newest], "without a newest backup every pure backup goes")
  const controlled = spawn(process.execPath, ["-e", "let count=0;process.send('ready');process.on('message',m=>{count++;process.send({message:m,count})});setTimeout(()=>{},10000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
  try {
    await once(controlled, "message")
    const controls = installerControls(controlled)
    const received = once(controlled, "message")
    controls.install()
    controls.install()
    controls.cancel()
    assert.deepEqual((await received)[0], { message: "install", count: 1 })
    assert.equal(controlled.killed, false, "Cancellation must not interrupt a dispatched install transaction")
  } finally { controlled.kill() }
  const renamed = spawn(
    process.execPath,
    ["-e", "process.title='renamed-test-process';setTimeout(()=>{},10000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  )
  const daemon = spawn(
    process.execPath,
    ["-e", "process.title='mako-terminal-daemon';setTimeout(()=>{},10000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] }
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const processes = await runningBundleProcesses(
      `/fixture/${basename(process.execPath)}.app`
    )
    assert.ok(
      renamed.pid && processes.includes(renamed.pid),
      "OS executable names must detect processes whose displayed title changed"
    )
    assert.ok(
      daemon.pid && !processes.includes(daemon.pid),
      "Mako's own detached daemons must not hold an install open"
    )
  } finally {
    renamed.kill()
    daemon.kill()
  }
  const polluted = {
    HOME: "/fixture",
    PATH: "/bin",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--inspect",
    MAKO_HOST_ONLY: "1",
    MAKO_PROFILE: "test",
    MAKO_DATA_ROOT: "/test",
    MAKO_CLIENT_ID: "test",
    MAKO_STANDALONE: "1",
    MAKO_WEB_SOCKET: "/test.sock",
    MAKO_WEB_ONLY: "1",
    MAKO_PROD: "1",
    MAKO_KIRI_BINARY: "/test-engine",
    VITE_DEV_SERVER_URL: "http://localhost:1",
  }
  assert.deepEqual(desktopLaunchEnvironment(polluted), {
    HOME: "/fixture",
    PATH: "/bin",
  })
  assert.equal(polluted.MAKO_HOST_ONLY, "1")

  // A TCC row follows the designated requirement it was written under. When
  // the installed app's requirement changes, the rows must be dropped so the
  // next Grant prompts; when it is unchanged, the grants must be left alone.
  const certificate =
    'identifier "dev.mako.app" and certificate root = H"41ccd4f5f2796876b03ea453c5d2c70a0018dbf8"'
  assert.equal(
    parseDesignatedRequirement(
      `Executable=/Applications/Mako.app/Contents/MacOS/Mako\ndesignated => ${certificate}\n`
    ),
    certificate
  )
  assert.equal(parseDesignatedRequirement("Executable=/x\n"), null)
  const requirements = new Map<string, string | null>()
  const calls: string[][] = []
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args])
    if (command === "codesign") {
      const requirement = requirements.get(args[2]!)
      if (requirement === undefined) throw new Error("code object is not signed at all")
      return { stdout: `designated => ${requirement}\n`, stderr: "" }
    }
    return { stdout: "", stderr: "" }
  }
  requirements.set("/target", certificate)
  requirements.set("/same", certificate)
  requirements.set("/adhoc", 'cdhash H"28298992fdab82a3c3964ffe7148d59dbc708d7a"')
  assert.equal(await reconcileGrantIdentity("/target", null, run), false)
  assert.equal(await reconcileGrantIdentity("/target", "/same", run), false)
  assert.ok(!calls.some(([command]) => command === "tccutil"))
  assert.equal(await reconcileGrantIdentity("/target", "/adhoc", run), true)
  assert.deepEqual(
    calls.filter(([command]) => command === "tccutil"),
    [
      ["tccutil", "reset", "Accessibility", MAKO_BUNDLE_ID],
      ["tccutil", "reset", "ScreenCapture", MAKO_BUNDLE_ID],
    ]
  )
  calls.length = 0
  assert.equal(await reconcileGrantIdentity("/target", "/unsigned", run), true)
  assert.equal(calls.filter(([command]) => command === "tccutil").length, 2)
  const grantReceipts: LocalInstallReceipt[] = []
  await completeLocalInstall({
    replace: async () => "/adhoc",
    save: async (receipt) => {
      grantReceipts.push(receipt)
    },
    grants: async () => true,
    launch: async () => {},
  })
  assert.deepEqual(grantReceipts, [
    { ok: true, backup: "/adhoc", message: GRANTS_RESET_MESSAGE },
  ])
  grantReceipts.length = 0
  await completeLocalInstall({
    replace: async () => "/same",
    save: async (receipt) => {
      grantReceipts.push(receipt)
    },
    grants: async () => false,
    launch: async () => {},
  })
  assert.deepEqual(grantReceipts, [{ ok: true, backup: "/same" }])

  console.log(
    "Local installation: rollback, retained failures, changed-target refusal, exclusive install lock, final running-process check, daemon exclusion, retained-copy pruning, fresh install, clean desktop environment and grant identity reconciliation passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
