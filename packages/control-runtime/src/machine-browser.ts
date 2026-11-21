import { command, spawn } from "./processes.js"
import type { ChildProcess } from "node:child_process"
import { statfsSync } from "node:fs"
import { get } from "node:http"
import { mkdir, rm } from "node:fs/promises"
import { join, win32 } from "node:path"
import { Readable, Writable } from "node:stream"
import { z } from "zod"
import type { LocalBrowser } from "./browser-discovery.js"
import { onLinux, onWindows } from "./platform.js"

export const MACHINE_BROWSER_ID = "chromium:machine"
/** Chromium keeps its pages' shared memory here; a container's default 64 MB crashes tabs. */
const SHARED_MEMORY_FLOOR = 512 * 1024 * 1024
const LISTENING = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)\s*$/m
/** Chromium's own advice here, to install its setuid helper, fails the same way: both need new namespaces. */
const NO_SANDBOX = /No usable sandbox!/
const SANDBOX_REFUSED = "Chromium can't start its sandbox: this machine refuses to create user namespaces, as a container's default seccomp profile does. Allow them, as a VM does (for Docker, a seccomp profile that permits them), rather than run the browser unsandboxed."

export interface MachineBrowserOptions {
  executable: string
  /** Its own profile, kept across launches so sign-ins survive a restart. */
  profile: string
  /** Chromium's sandbox; off only where the machine can't give it namespaces. */
  sandbox?: boolean
  startupMs?: number
  /** The window a new tab opens in. As in a person's Chromium, its page is shorter by the toolbar: 1280×713 in 1280×800. */
  window?: { width: number; height: number }
  /**
   * The capture extension (`machine-capture.ts`), written before each launch: live video of a tab is encoded inside
   * this Chromium. Without it, a tab's live video comes from its screencast.
   */
  captureExtension?: () => Promise<{ directory: string; id: string } | undefined>
  /** Each Chromium once it answers, for a registry that ends what a crashed host left running. */
  started?: (child: ChildProcess) => void
  /**
   * How the capture extension is loaded: by `--load-extension`, which Chromium and Edge honor, or over a DevTools pipe
   * (`Extensions.loadUnpacked`), as Google Chrome requires since it ignores that flag (137 on). The default is the flag.
   */
  extensionLoading?: "flag" | "pipe"
}

/**
 * The machine's own Chromium, for a machine with no person's browser: headless, started when an agent first connects
 * to it, so a Thread that never browses pays nothing. It starts again on the next connect after it exits.
 */
export class MachineBrowser {
  readonly definition: LocalBrowser
  readonly #options: MachineBrowserOptions
  #child: ChildProcess | undefined
  #starting: Promise<string> | undefined
  #closed = false

  constructor(options: MachineBrowserOptions) {
    this.#options = options
    this.definition = {
      id: MACHINE_BROWSER_ID,
      name: "Chromium",
      product: "Chromium",
      kind: "chromium",
      transport: "direct",
      requiresApproval: false,
      endpoint: () => this.#endpoint(),
    }
  }

  close(): void {
    this.#closed = true
    if (this.#child) end(this.#child, "SIGTERM")
    this.#child = undefined
  }

  /**
   * The running Chromium's DevTools endpoint, launching one when none runs. One that announced its endpoint and no
   * longer takes connections is gone even before its exit is heard: a killed Chromium's socket closes first, and a
   * connect in between was handed its port and refused (ECONNREFUSED; 4 of 200 test runs on a loaded runner). So a
   * kept endpoint is asked first (`accepts`), and one that doesn't answer starts Chromium again, once.
   */
  async #endpoint(again = true): Promise<string> {
    if (this.#closed) throw new Error("The machine's browser is shutting down")
    this.#starting ??= this.#launch().catch((error: Error) => {
      this.#starting = undefined
      throw error
    })
    const starting = this.#starting
    const endpoint = await starting
    if (!again || (await accepts(endpoint))) return endpoint
    if (this.#starting === starting) {
      const child = this.#child
      this.#child = undefined
      this.#starting = undefined
      if (child) end(child, "SIGKILL")
    }
    return this.#endpoint(false)
  }

  async #launch(): Promise<string> {
    const { executable, profile, sandbox = true, startupMs = 30_000, window = { width: 1280, height: 800 } } = this.#options
    await mkdir(profile, { recursive: true, mode: 0o700 })
    // A profile left by a Chromium that was killed names a port nobody listens on.
    await rm(join(profile, "DevToolsActivePort"), { force: true })
    const extension = await this.#options.captureExtension?.()
    if (this.#closed) throw new Error("The machine's browser is shutting down")
    const piped = Boolean(extension) && this.#options.extensionLoading === "pipe"
    const child = spawn(executable, [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${window.width},${window.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(onLinux() && sharedMemory() < SHARED_MEMORY_FLOOR ? ["--disable-dev-shm-usage"] : []),
      ...(sandbox ? [] : ["--no-sandbox"]),
      ...(extension && piped ? ["--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--allowlisted-extension-id=${extension.id}`] : []),
      ...(extension && !piped
        ? [`--load-extension=${extension.directory}`, `--disable-extensions-except=${extension.directory}`, `--allowlisted-extension-id=${extension.id}`]
        : []),
      "about:blank",
    // A DevTools pipe is fds 3 and 4, Chromium's input and output; it stays open while Chromium runs, which ends without it.
    ], { stdio: piped ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"], windowsHide: true })
    this.#child = child
    // SAFETY: stdio[2] is "pipe" in both launches; Node types a computed stdio array's streams as possibly absent.
    const stderr = child.stderr as Readable
    child.once("exit", () => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#starting = undefined
    })
    let output = ""
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Chromium didn't start within ${startupMs / 1000} s`)), startupMs)
        const settle = () => {
          clearTimeout(timer)
          stderr.off("data", read)
          child.off("exit", exited)
          child.off("error", failed)
        }
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192)
          const endpoint = LISTENING.exec(output)?.[1]
          if (!endpoint) return
          settle()
          resolve(endpoint)
        }
        const exited = (code: number | null, signal: NodeJS.Signals | null) => {
          settle()
          reject(new Error(NO_SANDBOX.test(output) ? SANDBOX_REFUSED : `Chromium exited (${code ?? signal}) before it started: ${lastLine(output)}`))
        }
        const failed = (error: Error) => {
          settle()
          reject(new Error(`Chromium couldn't start: ${error.message}`))
        }
        stderr.on("data", read)
        child.once("exit", exited)
        child.once("error", failed)
      })
      if (extension && piped) await loadOverPipe(child, extension.directory, extension.id, startupMs)
      this.#options.started?.(child)
      return endpoint
    } catch (error) {
      end(child, "SIGKILL")
      throw error
    } finally {
      // Its later output is never read, so the pipe must not fill and stall it.
      stderr.resume()
    }
  }
}

const loaded = z.object({ result: z.object({ id: z.string() }).optional(), error: z.object({ message: z.string() }).optional() })

/**
 * Loads an unpacked extension over Chromium's DevTools pipe (`--remote-debugging-pipe`): one command, NUL-terminated
 * JSON each way. It must answer with the extension's id before a capture asks for the extension.
 */
async function loadOverPipe(child: ChildProcess, directory: string, id: string, timeoutMs: number): Promise<void> {
  const input = child.stdio[3]
  const output = child.stdio[4]
  if (!(input instanceof Writable) || !(output instanceof Readable)) throw new Error("Chromium's DevTools pipe isn't open")
  const answer = await new Promise<string>((resolve, reject) => {
    let text = ""
    const timer = setTimeout(() => finish(new Error(`Chromium didn't load the capture extension within ${timeoutMs / 1000} s`)), timeoutMs)
    const finish = (error?: Error, reply?: string) => {
      clearTimeout(timer)
      output.off("data", read)
      child.off("exit", exited)
      if (error) reject(error)
      else resolve(reply ?? "")
    }
    const read = (chunk: Buffer) => {
      text += chunk.toString()
      const end = text.indexOf("\0")
      if (end >= 0) finish(undefined, text.slice(0, end))
    }
    const exited = () => finish(new Error("Chromium exited while loading the capture extension"))
    output.on("data", read)
    child.once("exit", exited)
    input.write(`${JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: directory } })}\0`)
  })
  const reply = loaded.safeParse(JSON.parse(answer))
  if (!reply.success || reply.data.result?.id !== id)
    throw new Error(`Chromium didn't load the capture extension: ${reply.data?.error?.message ?? answer.slice(0, 300)}`)
  // Its later output is never read; it must not fill and stall Chromium.
  output.resume()
}

/**
 * Ends Chromium and every process it started. On Windows a kill ends only the browser process, and its GPU, network
 * and renderer processes notice later or not at all, so the whole tree goes at once (`taskkill /T /F`).
 */
function end(child: ChildProcess, signal: NodeJS.Signals): void {
  if (onWindows() && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    // By its whole path: a bare name is looked for in the working folder first on Windows.
    const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe")
    void command(taskkill, ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true }).catch(() => child.kill(signal))
    return
  }
  child.kill(signal)
}

/** Ways a DevTools port says nobody serves it: refused, or taken by a process going away and then reset. */
const GONE = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"])

/**
 * Whether DevTools answers at an endpoint's port: any HTTP answer is a live one. A bare TCP connect isn't, since a
 * killed Chromium's listening socket can still take one while the process goes, and the WebSocket after it was reset
 * (1 of 200 loaded runs). Only a refusal or a reset says no; a slow answer counts as live, so a busy one isn't dropped.
 */
function accepts(endpoint: string): Promise<boolean> {
  const { hostname, port } = new URL(endpoint)
  return new Promise((resolve) => {
    const request = get({ host: hostname, port: Number(port), path: "/json/version", timeout: 1_000 }, (response) => {
      response.resume()
      resolve(true)
    })
    request.once("timeout", () => {
      request.destroy()
      resolve(true)
    })
    request.once("error", (error: NodeJS.ErrnoException) => resolve(!GONE.has(error.code ?? "")))
  })
}

function sharedMemory(): number {
  try {
    const { bsize, blocks } = statfsSync("/dev/shm")
    return bsize * blocks
  } catch {
    return 0
  }
}

function lastLine(output: string): string {
  return output.trim().split("\n").at(-1)?.slice(0, 500) || "no output"
}
