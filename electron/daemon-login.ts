/**
 * Start the sync daemon at login — opt-in, and honest about the mechanism.
 *
 * A LaunchAgent plist under the user's own ~/Library/LaunchAgents, running
 * the app's binary in Node mode against the daemon script. Nothing is
 * installed system-wide, nothing needs privileges, and removing the toggle
 * removes the file and unloads the job. `KeepAlive` restarts it if it dies;
 * the daemon's own single-instance check makes that safe alongside the app
 * spawning it too — whoever starts first wins, everyone else exits quietly.
 *
 * The plist pins the binary path and Node flags. Startup compares the desired
 * definition with the installed one and refreshes it only when an update moved
 * the app or changed the daemon runtime contract.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { DAEMON_NODE_ARGS } from "./daemon-command.js"
import { buildTag } from "./build-identity.js"
import { headlessNodeExecutable } from "./headless-node.js"

const run = promisify(execFile)

const LABEL = "com.mako.syncd"

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
}

export function daemonScript(): string {
  return join(app.getAppPath(), "node_modules", "@mako", "sessions", "dist", "daemon-main.js")
}

/**
 * Only the installed app may own the login job. A checkout that wrote one would
 * pin the user's always-on sync to a working tree that changes under it and
 * outlives every window the checkout ever opened.
 */
export function daemonLoginOwner(): boolean {
  return app.isPackaged
}

function daemonPlist(script = daemonScript()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${headlessNodeExecutable()}</string>
${DAEMON_NODE_ARGS.map((argument) => `    <string>${argument}</string>`).join("\n")}
    <string>${script}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>MAKO_DAEMON_VERSION</key><string>${buildTag()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
</dict>
</plist>
`
}

/** The user said no, once, explicitly. Recorded so the default stays off. */
function optOutPath(): string {
  return join(homedir(), ".mako", "syncd-login-optout")
}

/**
 * Session sync runs inside the app by default. An existing login job is an
 * explicit always-on choice and is refreshed when its command changes.
 */
export async function refreshDaemonLoginJob(): Promise<void> {
  if (process.platform !== "darwin" || !daemonLoginOwner()) return
  try {
    const current = await readFile(plistPath(), "utf8").catch(() => null)
    if (!current) {
      // launchd still running a job whose definition is gone: a leftover from
      // another build that nothing manages any more. Stop it before it serves
      // this app stale data forever.
      if ((await daemonLoginJob()).loaded) await stopDaemonLoginJob()
      return
    }
    if (existsSync(optOutPath())) return
    if (current === daemonPlist()) return
    await setDaemonLogin(true)
  } catch {
    // A failed install stays quiet; the settings toggle still works.
  }
}

function launchdUid(): number {
  return process.getuid?.() ?? 501
}

/**
 * Whether launchd currently holds the job, and under which pid if it runs.
 * `launchctl print` is the only honest source: `bootstrap` and `bootout`
 * report errors for jobs they did in fact load or unload, which once left a
 * job running for days with its plist deleted and no host able to see it.
 */
export async function daemonLoginJob(): Promise<{ loaded: boolean; pid: number | null }> {
  if (process.platform !== "darwin") return { loaded: false, pid: null }
  try {
    const { stdout } = await run("launchctl", ["print", `gui/${launchdUid()}/${LABEL}`])
    const match = /\bpid = (\d+)/.exec(stdout)
    return { loaded: true, pid: match ? Number(match[1]) : null }
  } catch {
    return { loaded: false, pid: null }
  }
}

export async function daemonLoginProcess(): Promise<number | null> {
  return (await daemonLoginJob()).pid
}

/** Unload the job and wait until launchd agrees it is gone. */
export async function stopDaemonLoginJob(): Promise<void> {
  if (process.platform !== "darwin") return
  await run("launchctl", ["bootout", `gui/${launchdUid()}/${LABEL}`]).catch(() => {})
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await daemonLoginJob()).loaded) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function daemonLoginEnabled(): Promise<boolean> {
  if (process.platform !== "darwin") return false
  try {
    return (await readFile(plistPath(), "utf8")).includes(LABEL)
  } catch {
    return false
  }
}

export async function setDaemonLogin(enabled: boolean): Promise<void> {
  const { mkdir: makeDir, rm: remove, writeFile: write } = await import("node:fs/promises")
  if (enabled) {
    await remove(optOutPath(), { force: true }).catch(() => {})
  } else {
    await makeDir(join(homedir(), ".mako"), { recursive: true }).catch(() => {})
    await write(optOutPath(), "").catch(() => {})
  }
  if (process.platform !== "darwin") {
    throw new Error("Login start is only wired up for macOS so far")
  }
  if (enabled && !daemonLoginOwner())
    throw new Error("Login sync is installed from the installed Mako app, not from a development checkout.")
  if (!enabled) {
    await stopDaemonLoginJob()
    await rm(plistPath(), { force: true })
    return
  }

  const script = daemonScript()
  if (!existsSync(script)) throw new Error("The daemon script is missing from this build")

  const plist = daemonPlist(script)
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
  await writeFile(plistPath(), plist, "utf8")
  // Re-bootstrap so a re-save (after an app update moved the binary) takes.
  // The old job must be fully gone first: bootstrapping over a job still
  // unloading fails with "already loaded" even though the new definition
  // never took.
  await stopDaemonLoginJob()
  let failure: Error | null = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await run("launchctl", ["bootstrap", `gui/${launchdUid()}`, plistPath()])
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    // The job's presence decides, not the exit code: launchctl has returned an
    // I/O error for a bootstrap that loaded the job. Deleting the plist on that
    // verdict is what strands a job with no definition behind it.
    if ((await daemonLoginJob()).loaded) return
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
  }
  // A plist launchd will not load should not stay on disk claiming otherwise.
  await rm(plistPath(), { force: true })
  throw new Error(`launchctl refused the job: ${failure?.message ?? "unknown error"}`)
}
