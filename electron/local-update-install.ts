import { fork, type ChildProcess } from "node:child_process"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { physicalFiles } from "./physical-files.js"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyLocalCandidate } from "./local-updates.js"
import { resolveExecutable } from "./executable.js"
import {
  desktopLaunchEnvironment,
  unregisterBundle,
} from "./local-update-installer.js"

export async function prepareLocalInstall(
  candidate: { app: string; identity: string },
  receipt: string
) {
  const node = resolveExecutable("node")
  if (!node)
    throw new Error("Node.js is required to complete this local update.")
  const target = await lstat("/Applications/Mako.app")
  if (!target.isDirectory() || target.isSymbolicLink())
    throw new Error(
      "Install Mako in /Applications before using in-app updates."
    )
  await mkdir(dirname(receipt), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp("/Applications/.mako-update-")
  const app = join(staging, "Mako.app")
  await (await physicalFiles()).cp(candidate.app, app, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  await verifyLocalCandidate(app, candidate.identity)
  const script = join(staging, "installer.mjs")
  await writeFile(script, await readFile(join(dirname(fileURLToPath(import.meta.url)), "local-update-installer.js")), { mode: 0o600 })
  const child = fork(
    script,
    [staging, candidate.identity, String(process.pid), receipt],
    {
      execPath: node,
      env: desktopLaunchEnvironment(process.env),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
    }
  )
  // A staging directory nothing resumed would sit in /Applications forever:
  // ~850 MB of dead bundle that LaunchServices can still register against the
  // installed app's bundle id.
  const abandon = async () => {
    await unregisterBundle(app)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(
          new Error("The installer did not become ready. Mako is still running.")
        )
      }, 70_000)
      child.once("message", (message) => {
        clearTimeout(timer)
        if (message === "ready") resolve()
        else reject(new Error("The installer returned an invalid response."))
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", () => {
        clearTimeout(timer)
        reject(new Error("The installer exited before it was ready."))
      })
    })
  } catch (error) {
    await abandon()
    throw error
  }
  return installerControls(child, abandon)
}

export function installerControls(child: ChildProcess, abandon?: () => Promise<void>) {
  let dispatched = false
  return {
    install() {
      if (dispatched) return
      if (!child.connected)
        throw new Error("The prepared installer is no longer running.")
      child.send("install")
      dispatched = true
      child.unref()
    },
    cancel() {
      if (!dispatched) {
        child.kill()
        void abandon?.()
      }
    },
  }
}
