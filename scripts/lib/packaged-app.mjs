import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { threadDebugPort } from "../thread-debug-port.mjs"

/**
 * A packaged Mako run in an isolated standalone profile under `root`, driven
 * over the renderer's DevTools protocol. It never reaches the user's Mako:
 * its own user data directory, a dead backend, and only the process group it
 * spawned is ever signalled.
 */
export class PackagedApp {
  /**
   * `args` and `env` run a built checkout instead of a package: its Electron
   * as `executable`, the checkout in `args` and `MAKO_PROD` in `env`.
   * @param {{ executable: string, root: string, workspace: string, args?: string[], env?: Record<string, string>, onStdoutLine?: (line: string) => void }} options
   */
  constructor({ executable, root, workspace, args = [], env = {}, onStdoutLine }) {
    this.executable = executable
    this.args = args
    this.extraEnv = env
    this.root = root
    this.workspace = workspace
    this.onStdoutLine = onStdoutLine
    this.child = undefined
    this.socket = undefined
    this.counter = 0
    this.callbacks = new Map()
    this.launchError = undefined
  }

  get profile() {
    return join(this.root, "profile")
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
    await rm(join(this.profile, "DevToolsActivePort"), { force: true })
    this.launchError = undefined
    // A probe started from inside a Mako Thread inherits that Mako's control
    // session, ports and data folder; none of them may reach the package.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_"))),
      MAKO_STANDALONE: "1",
      MAKO_DATA_ROOT: this.profile,
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
        `--user-data-dir=${this.profile}`,
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
          return Number((await readFile(join(this.profile, "DevToolsActivePort"), "utf8")).split("\n")[0])
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
    return { url: target.url, pid: child.pid }
  }

  /**
   * Stops the package's process group. `graceful` signals only the host, as
   * a quit does, and gives it time to close its providers itself first.
   */
  async stop({ graceful = false } = {}) {
    this.socket?.close()
    this.socket = undefined
    const child = this.child
    if (child && child.exitCode === null) {
      process.kill(graceful ? child.pid : -child.pid, "SIGTERM")
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(graceful ? 30_000 : 5000)])
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        /* The owned process group has exited. */
      }
    }
    this.child = undefined
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
