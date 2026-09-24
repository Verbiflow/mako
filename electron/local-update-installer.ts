import { execFile } from "node:child_process"
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
interface PreparedApplication {
  staging: string
  target: string
  verify(path: string): Promise<void>
  ready(): Promise<void>
}

async function appStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

/**
 * Every staged, retained or failed bundle is a real `dev.mako.app`
 * application, and LaunchServices registers whatever it finds under
 * /Applications or whatever was ever opened. A record left pointing at a
 * moved or deleted copy makes `open -a` and the Dock resolve to it instead
 * of the installed app, which macOS then reports as "not open anymore".
 * Best-effort: a bundle that was never scanned has nothing to drop.
 */
export async function unregisterBundle(app: string): Promise<void> {
  await execute(LSREGISTER, ["-u", app], { timeout: 30_000 }).catch(
    () => undefined
  )
}

export async function replacePreparedApplication(
  input: PreparedApplication
): Promise<string | null> {
  const lockPath = `${input.target}.update-lock`
  const lock = await open(lockPath, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(
          `Another installer owns ${lockPath}. No application files were changed. If a previous installer crashed, verify that it has stopped before removing its lock.`
        )
      throw error
    }
  )
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }))
    const candidate = join(input.staging, "Mako.app")
    const backup = join(input.staging, "Previous Mako.app")
    const current = await appStat(input.target)
    if (current && (!current.isDirectory() || current.isSymbolicLink()))
      throw new Error(
        "The installed app is not a regular application directory"
      )
    if (await appStat(backup))
      throw new Error(
        "This installation already has a backup. Use a new staging directory."
      )
    await input.verify(candidate)
    await input.ready()
    const latest = await appStat(input.target)
    if (current?.dev !== latest?.dev || current?.ino !== latest?.ino)
      throw new Error(
        "The installed application changed during preparation. Nothing was replaced."
      )
    if (current) await rename(input.target, backup)
    try {
      await rename(candidate, input.target)
      await input.verify(input.target)
      if (current) await unregisterBundle(backup)
    } catch (error) {
      try {
        if (await appStat(input.target)) {
          const failed = await mkdtemp(join(input.staging, "failed-"))
          const rejected = join(failed, "Mako.app")
          await rename(input.target, rejected)
          await unregisterBundle(rejected)
        }
        if (current) await rename(backup, input.target)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Installation and rollback failed. The previous application is retained at ${backup}; do not remove that directory.`,
          { cause: rollbackError }
        )
      }
      throw error
    }
    return current ? backup : null
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

/**
 * Mako's own detached daemons, by the title each sets for itself. They are
 * spawned from the bundle's executable and outlive the host on purpose, so the
 * OS executable name counts them as the app; an installer waiting for "Mako to
 * close" would then wait for a daemon that never closes. The next host
 * replaces any daemon from another build on first contact, so leaving them
 * running across an install is safe. The title is trusted only to *exclude* a
 * process; nothing that renames itself can evade the executable-name check.
 */
export const MAKO_DAEMON_TITLES: ReadonlySet<string> = new Set([
  "mako-terminal-daemon",
  "mako-syncd",
  "mako-cursor-sdk",
])

function processLines(output: string): Array<{ pid: number; command: string }> {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), command: match[2]!.trim() }] : []
  })
}

export function bundleProcessIds(output: string, bundle: string): number[] {
  const name = basename(bundle, ".app")
  return processLines(output).flatMap(({ pid, command }) =>
    command.startsWith(`${bundle}/Contents/`) ||
    command === name ||
    command.startsWith(`${name} Helper`)
      ? [pid]
      : []
  )
}

/** Pids whose displayed command is one of Mako's daemon titles. */
export function daemonProcessIds(output: string): number[] {
  return processLines(output).flatMap(({ pid, command }) =>
    MAKO_DAEMON_TITLES.has(command) ? [pid] : []
  )
}

export async function runningBundleProcesses(
  bundle: string,
  run: Run = (command, args) => execute(command, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
): Promise<number[]> {
  const [byTitle, byExecutable] = await Promise.all(
    ["comm=", "ucomm="].map(async (field) => {
      const { stdout } = await run("ps", ["-axo", "pid=", "-o", field])
      return stdout
    })
  )
  const daemons = new Set(daemonProcessIds(byTitle!))
  const titles = new Map(processLines(byTitle!).map(({ pid, command }) => [pid, command]))
  const candidates = [
    ...new Set([
      ...bundleProcessIds(byTitle!, bundle),
      ...bundleProcessIds(byExecutable!, bundle),
    ]),
  ].filter((pid) => !daemons.has(pid))
  const retained = await Promise.all(candidates.map(async (pid) => {
    if (titles.get(pid) !== "mako-browser-host") return false
    const files = await run("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]).catch(() => null)
    const helpers = files?.stdout.split("\n").filter(line => line.startsWith("n/") &&
      line.endsWith("/Contents/Frameworks/Mako Helper.app/Contents/MacOS/Mako Helper")) ?? []
    // The browser bridge runs from a retained bundle so replacing /Applications
    // cannot affect it. Its OS executable name is still "Mako Helper".
    return helpers.length > 0 && helpers.every(line => !line.startsWith(`n${bundle}/Contents/`))
  }))
  return candidates.filter((_pid, index) => !retained[index])
}

/** Browser-owned native messaging survives host Quit. Its extension reconnects. */
export async function stopBundleBrowserHosts(
  bundle: string,
  run: Run = defaultRun,
  signal: (pid: number) => void = (pid) => { process.kill(pid, "SIGTERM") }
): Promise<void> {
  const { stdout } = await run("ps", ["-axo", "pid=,comm="])
  for (const process of processLines(stdout)) {
    if (process.command !== "mako-browser-host") continue
    const executable = join(bundle, "Contents/Frameworks/Mako Helper.app/Contents/MacOS/Mako Helper")
    const files = await run("lsof", ["-a", "-p", String(process.pid), "-d", "txt", "-Fn"]).catch(() => null)
    if (!files?.stdout.split("\n").includes(`n${executable}`)) continue
    // Recheck the title after inspecting the executable, before signalling.
    const current = await run("ps", ["-p", String(process.pid), "-o", "comm="]).catch(() => null)
    if (current?.stdout.trim() !== "mako-browser-host") continue
    try { signal(process.pid) } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
}

/** Reap only orphaned crash reporters after the authorized host has exited. */
export async function stopOrphanedBundleCrashReporters(
  bundle: string,
  run: Run = defaultRun,
  signal: (pid: number) => void = (pid) => { process.kill(pid, "SIGTERM") },
  uid = process.getuid?.()
): Promise<void> {
  if (uid === undefined) return
  const executable = join(bundle, "Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler")
  const resolvedExecutable = await realpath(executable).catch(() => executable)
  const parse = (output: string) => output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match && Number(match[2]) === 1 && Number(match[3]) === uid && match[4]!.trim() === executable
      ? [Number(match[1])] : []
  })
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,uid=,comm="])
  for (const pid of parse(stdout)) {
    const files = await run("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]).catch(() => null)
    if (!files?.stdout.split("\n").some(line => line === `n${executable}` || line === `n${resolvedExecutable}`)) continue
    const current = await run("ps", ["-p", String(pid), "-o", "pid=,ppid=,uid=,comm="]).catch(() => null)
    if (!current || !parse(current.stdout).includes(pid)) continue
    try { signal(pid) } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
}

const RETAINED_STAGING = /^\.mako-(update|local-install)-[A-Za-z0-9]+$/
const RETAINED_CONTENTS = new Set(["Previous Mako.app", "installer.mjs", "local-update-startup.mjs"])

/**
 * Remove older retained applications once a new install has been verified
 * and launched. Every install keeps the app it replaced beside the target;
 * four of those were found holding 3.4 GB with nothing ever reclaiming them.
 *
 * Only the newest backup survives. A staging directory is removed only when
 * it holds nothing but a retained app and its installer script: one that
 * still contains a candidate, or a `failed-*` directory from a rollback, is
 * evidence and stays. The install lock is held throughout so no concurrent
 * installer is between renames with a backup it may still need.
 */
export async function pruneRetainedApplications(
  target: string,
  keep: string | null
): Promise<string[]> {
  const applications = dirname(target)
  const kept = keep ? dirname(keep) : null
  const lockPath = `${target}.update-lock`
  const lock = await open(lockPath, "wx", 0o600).catch(() => null)
  if (!lock) return []
  const removed: string[] = []
  try {
    const uid = process.getuid?.()
    for (const name of await readdir(applications)) {
      if (!RETAINED_STAGING.test(name)) continue
      const staging = join(applications, name)
      if (staging === kept) continue
      const info = await lstat(staging).catch(() => null)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue
      if (uid !== undefined && info.uid !== uid) continue
      const contents = await readdir(staging).catch(() => null)
      if (!contents || contents.some((entry) => !RETAINED_CONTENTS.has(entry))) continue
      await unregisterBundle(join(staging, "Previous Mako.app"))
      await rm(staging, { recursive: true, force: true })
      removed.push(staging)
    }
  } finally {
    await lock.close()
    await unlink(lockPath).catch(() => undefined)
  }
  return removed
}

export function desktopLaunchEnvironment(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "MAKO_DATA_ROOT",
    "MAKO_PROFILE",
    "MAKO_HOST_ONLY",
    "MAKO_STANDALONE",
    "MAKO_WEB_SOCKET",
    "MAKO_WEB_ONLY",
    "MAKO_CLIENT_ID",
    "MAKO_PROD",
    "MAKO_KIRI_BINARY",
    "VITE_DEV_SERVER_URL",
  ])
    delete clean[key]
  return clean
}

export type LocalInstallReceipt =
  | { ok: true; backup: string | null; message?: string; startup?: "pending" | "verified" | "failed" }
  | { ok: false; message: string }

export const MAKO_BUNDLE_ID = "dev.mako.app"
export const MAKO_GRANT_SERVICES = ["Accessibility", "ScreenCapture"] as const
export const GRANTS_RESET_MESSAGE =
  "Mako's signing identity changed, so macOS no longer honours its Accessibility and Screen Recording grants. Grant both again in Settings > Integrations."

type Run = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
const defaultRun: Run = (command, args) =>
  execute(command, args, { timeout: 60_000, maxBuffer: 1024 * 1024 })

export function parseDesignatedRequirement(output: string): string | null {
  return /^designated => (.+)$/m.exec(output)?.[1]?.trim() ?? null
}

/** The app's designated requirement as codesign prints it, or null when unsigned. */
export async function designatedRequirement(
  app: string,
  run: Run = defaultRun
): Promise<string | null> {
  const result = await run("codesign", ["--display", "-r-", app]).catch(
    () => null
  )
  return result ? parseDesignatedRequirement(result.stdout + result.stderr) : null
}

/**
 * A TCC grant is bound to the designated requirement the app had when it was
 * written. Replacing the app with one whose requirement differs (an ad-hoc
 * cdhash, the move to a certificate, a new certificate) leaves the rows in
 * place: System Settings shows the toggles on while tccd denies every request
 * and never prompts again. Drop the rows so the next Grant gets a fresh
 * decision, and say so in the receipt. Returns true when rows were reset.
 */
export async function reconcileGrantIdentity(
  target: string,
  backup: string | null,
  run: Run = defaultRun
): Promise<boolean> {
  if (!backup) return false
  const [previous, next] = await Promise.all([
    designatedRequirement(backup, run),
    designatedRequirement(target, run),
  ])
  if (previous !== null && previous === next) return false
  let reset = false
  for (const service of MAKO_GRANT_SERVICES) {
    const outcome = await run("tccutil", ["reset", service, MAKO_BUNDLE_ID]).then(
      () => true,
      () => false
    )
    reset ||= outcome
  }
  return reset
}

interface InstallCompletion {
  replace(): Promise<string | null>
  save(receipt: LocalInstallReceipt): Promise<void>
  launch(): Promise<void>
  verifyStarted?(): Promise<void>
  /** Drops TCC rows a changed signing identity orphaned; true when it did. */
  grants?(backup: string | null): Promise<boolean>
  /** Housekeeping after a verified, launched install; never affects the receipt. */
  prune?(backup: string | null): Promise<void>
}

export async function completeLocalInstall(
  input: InstallCompletion
): Promise<void> {
  let backup: string | null
  try {
    backup = await input.replace()
  } catch (error) {
    await input.save({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Installation failed. The previous application was retained.",
    })
    await input.launch().catch(() => {})
    throw error
  }
  const reset = await input.grants?.(backup).catch(() => false)
  const notice = reset ? { message: GRANTS_RESET_MESSAGE } : {}
  const installed: LocalInstallReceipt = { ok: true, backup, ...notice }
  if (input.verifyStarted) installed.startup = "pending"
  await input.save(installed)
  try {
    await input.launch()
    await input.verifyStarted?.()
  } catch (error) {
    await input.save({
      ok: true,
      backup,
      startup: "failed",
      message:
        `The update was installed, but Mako could not reopen or confirm startup. The previous app is retained${backup ? ` at ${backup}` : ""}. ${error instanceof Error ? error.message : "Open Mako from Applications."}`,
    })
    throw error
  }
  if (input.verifyStarted) await input.save({ ok: true, backup, ...notice, startup: "verified" })
  await input.prune?.(backup).catch(() => undefined)
}

async function runInstaller(): Promise<void> {
  const [staging, identity, pidText, receipt, build, socket] = process.argv.slice(2)
  if (
    !staging ||
    !/^\/Applications\/\.mako-update-[a-zA-Z0-9]+$/.test(staging) ||
    !identity ||
    !/^[a-fA-F0-9]{40}$/.test(identity) ||
    !pidText ||
    !/^\d+$/.test(pidText) ||
    !receipt || !build || !/^[a-f0-9]{12,64}$/.test(build) || !socket
  )
    throw new Error("Invalid local installer arguments")
  const target = "/Applications/Mako.app"
  const hostPid = Number(pidText)
  let authorized = false
  const verify = async (path: string) => {
    await execute(
      "codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "--test-requirement",
        `=identifier "dev.mako.app" and certificate leaf = H"${identity}"`,
        path,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
  }
  try {
    const directory = await lstat(staging)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077
    )
      throw new Error("The install staging directory is not private")
    await verify(join(staging, "Mako.app"))
    process.send?.("ready")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The host did not authorize installation")),
        60_000
      )
      process.once("message", (message) => {
        clearTimeout(timer)
        if (message === "install") resolve()
        else reject(new Error("Invalid installation authorization"))
      })
      process.once("disconnect", () => {
        clearTimeout(timer)
        reject(
          new Error("The host disconnected without authorizing installation")
        )
      })
    })
    authorized = true
    process.disconnect?.()
    const deadline = Date.now() + 60_000
    for (;;) {
      let hostAlive = true
      try {
        process.kill(hostPid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          hostAlive = false
        else throw error
      }
      if (!hostAlive) {
        await stopBundleBrowserHosts(target)
        await stopOrphanedBundleCrashReporters(target)
      }
      const pids = await runningBundleProcesses(target)
      if (!hostAlive && !pids.length) break
      if (Date.now() >= deadline)
        throw new Error(
          `Mako processes are still running${pids.length ? ` (pid ${pids.join(", ")})` : hostAlive ? ` (host pid ${hostPid})` : ""}. Quit Mako and close its MCP clients before installing.`
        )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  } catch (error) {
    await unregisterBundle(join(staging, "Mako.app"))
    if (authorized) {
      await writeFile(
        receipt,
        JSON.stringify({
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "The update could not be installed. The previous app was retained.",
        }),
        { mode: 0o600 }
      )
      await execute("open", ["-n", target], {
        timeout: 10_000,
        env: desktopLaunchEnvironment(process.env),
      }).catch(() => {})
    }
    process.exitCode = 1
    if (process.connected) process.disconnect()
    return
  }
  await completeLocalInstall({
    replace: () =>
      replacePreparedApplication({
        staging,
        target,
        verify,
        ready: async () => {
          if ((await runningBundleProcesses(target)).length)
            throw new Error(
              "Mako started during verification. Nothing was replaced."
            )
        },
      }),
    save: async (result) => {
      await writeFile(receipt, JSON.stringify(result), { mode: 0o600 })
    },
    grants: (backup) => reconcileGrantIdentity(target, backup),
    verifyStarted: async () => {
      // SAFETY: preparation copies our bundled local-update-startup module into this private directory.
      const { verifyLocalStartup } = await import(pathToFileURL(join(staging, "local-update-startup.mjs")).href) as typeof import("./local-update-startup.js")
      await verifyLocalStartup({ socket, build, previousPid: hostPid })
    },
    launch: async () => {
      // `-n` matters: the bundle was just swapped under a path LaunchServices
      // still associates with the killed instance, and a plain `open` can be
      // routed as an activation of that dead registration — macOS then shows
      // "The application "Mako" is not open anymore." Forcing a new instance
      // never takes the activate-existing path.
      await execute("open", ["-n", target], {
        timeout: 10_000,
        env: desktopLaunchEnvironment(process.env),
      })
    },
    prune: async (backup) => {
      await pruneRetainedApplications(target, backup)
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runInstaller().catch(() => {
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
