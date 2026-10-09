import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { clientRoot, runtimeLocation } from "../../dist-electron/runtime-service.js"
import { probeRuntime } from "../../dist-electron/runtime-connection.js"
import { threadDebugPort } from "../thread-debug-port.mjs"

const PROBE_CLIENT = "packaged-probe"

/**
 * A packaged Mako's desktop run on an isolated profile under `root`, driven
 * over its window's DevTools protocol; the desktop starts that profile's own
 * host, as Node, as it always does. It never reaches the user's Mako: its own
 * data root and client folder, a mock keychain, a dead backend, and only the
 * desktop it spawned and that profile's host are ever signalled.
 */
export class PackagedApp {
  /**
   * `args` and `env` run a built checkout instead of a package: its Electron
   * as `executable`, the checkout in `args` and `MAKO_PROD` in `env`. A key
   * set to undefined in `env` is left out of the desktop's, and so its host's.
   * @param {{ executable: string, root: string, workspace: string, args?: string[], env?: Record<string, string | undefined>, onStdoutLine?: (line: string) => void }} options
   */
  constructor({ executable, root, workspace, args = [], env = {}, onStdoutLine }) {
    this.executable = executable
    this.args = args
    this.extraEnv = env
    this.root = root
    this.workspace = workspace
    this.onStdoutLine = onStdoutLine
    this.child = undefined
    this.hostPid = undefined
    this.socket = undefined
    this.counter = 0
    this.callbacks = new Map()
    this.launchError = undefined
  }

  get profile() {
    return join(this.root, "profile")
  }

  /** The desktop's own folder beside the profile: its renderer storage, DevTools port and log. */
  get clientFolder() {
    return clientRoot(this.profile, PROBE_CLIENT)
  }

  /** The profile's host, or nothing once it has gone. */
  async host() {
    const probe = await probeRuntime(runtimeLocation(this.profile).socket, { timeoutMs: 2_000 }).catch(() => undefined)
    return probe?.state === "ready" ? probe.info : undefined
  }

  command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter
      const timer = setTimeout(() => {
        this.callbacks.delete(id)
        reject(new Error(`Timed out: ${method}`))
      }, 120_000)
      this.callbacks.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }

  bridge(name, args) {
    return this.evaluate(`window.mako[${JSON.stringify(name)}](...${JSON.stringify(args)})`)
  }

  async waitFor(read, predicate, label, timeout = 90_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.launchError) throw this.launchError
      if (this.child?.exitCode !== null || this.child?.signalCode)
        throw new Error(
          `Package exited during ${label}: code=${this.child?.exitCode}, signal=${this.child?.signalCode}`
        )
      const value = await read()
      if (predicate(value)) return value
      await delay(250)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  async screenshot(path) {
    const shot = await this.command("Page.captureScreenshot", { format: "png" })
    await writeFile(path, Buffer.from(shot.data, "base64"))
    return path
  }

  async start() {
    await rm(join(this.clientFolder, "DevToolsActivePort"), { force: true })
    this.launchError = undefined
    // A probe started from inside a Mako Thread inherits that Mako's control
    // session, ports and data folder; none of them may reach the package.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_"))),
      MAKO_DATA_ROOT: this.profile,
      MAKO_CLIENT_ID: PROBE_CLIENT,
      MAKO_CURSOR_SDK_ROOT: join(this.root, "cursor"),
      ...this.extraEnv,
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.VITE_DEV_SERVER_URL
    const debugPort = await threadDebugPort()
    const child = spawn(
      this.executable,
      [
        ...this.args,
        // The desktop hands its host the data key; a mock keychain keeps the person's items out of reach.
        "--use-mock-keychain",
        `--remote-debugging-port=${debugPort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { cwd: this.workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }
    )
    this.child = child
    child.stderr.resume()
    let buffer = ""
    child.stdout.on("data", (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-8192)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) this.onStdoutLine?.(line)
    })
    child.once("error", (error) => {
      this.launchError = error
    })
    const port = await this.waitFor(
      async () => {
        if (debugPort) return debugPort
        try {
          return Number((await readFile(join(this.clientFolder, "DevToolsActivePort"), "utf8")).split("\n")[0])
        } catch {
          return 0
        }
      },
      Boolean,
      "debugger"
    )
    const target = await this.waitFor(
      async () => {
        try {
          return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
            (item) => item.type === "page" && item.url.startsWith("mako-app:")
          )
        } catch {
          return null
        }
      },
      Boolean,
      "packaged renderer"
    )
    this.socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve)
      this.socket.once("error", reject)
    })
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString())
      if (message.id) {
        const callback = this.callbacks.get(message.id)
        this.callbacks.delete(message.id)
        callback?.(message)
      }
    })
    await this.waitFor(
      () => this.evaluate("Boolean(window.mako && document.querySelector('.composer-input'))"),
      Boolean,
      "preload and composer"
    )
    this.hostPid = (await this.waitFor(() => this.host(), Boolean, "the profile's host")).pid
    return { url: target.url, pid: child.pid, hostPid: this.hostPid }
  }

  /**
   * Closes the desktop, then stops the profile's host and its process group.
   * `graceful` signals only the host first, as a quit does, and gives it time
   * to close its providers itself.
   */
  async stop({ graceful = false } = {}) {
    this.socket?.close()
    this.socket = undefined
    const child = this.child
    if (child && child.exitCode === null) {
      process.kill(-child.pid, "SIGTERM")
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)])
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        /* The desktop's process group has exited. */
      }
    }
    this.child = undefined
    this.hostPid = undefined
    const host = await this.host()
    if (!host) return
    // `ensureRuntime` starts the host detached, so it leads its own process group.
    process.kill(graceful ? host.pid : -host.pid, "SIGTERM")
    const gone = async () => { try { process.kill(host.pid, 0); return false } catch { return true } }
    const deadline = Date.now() + (graceful ? 30_000 : 5000)
    while (!(await gone()) && Date.now() < deadline) await delay(100)
    try {
      process.kill(-host.pid, "SIGKILL")
    } catch {
      /* The host's process group has exited. */
    }
  }
}

/** The blocks after a turn's prompt, from the live window or, once covered, from native history. */
export function turnBlocks(snapshot, requestId) {
  const index = snapshot.blocks.findIndex(
    (block) => block.type === "user" && block.requestId === requestId
  )
  if (index < 0) {
    const request = snapshot.requests.find(item => item.id === requestId)
    assert.ok(request, 'Requested turn is missing')
    const entries = snapshot.base?.entries ?? []
    // Native history includes Mako's injected control instructions. Strip only
    // that known leading envelope; the user's entire prompt must still match.
    const userText = text => text.replace(/^<mako-local-control>\n[\s\S]*?\n<\/mako-local-control>\n\n/, '')
    const matches = entries.flatMap((entry, at) => entry.kind === 'user' && userText(entry.text) === request.text ? [at] : [])
    assert.equal(matches.length, 1, 'Native history must contain one exact matching prompt')
    const following = entries.slice(matches[0] + 1)
    const nextUser = following.findIndex(entry => entry.kind === 'user')
    return following.slice(0, nextUser < 0 ? undefined : nextUser)
      .filter(entry => entry.kind === 'assistant').flatMap(entry => entry.blocks)
  }
  return snapshot.blocks.slice(index + 1)
}
/** The text a turn answered with. */
export function answerText(snapshot, requestId) {
  return turnBlocks(snapshot, requestId)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
