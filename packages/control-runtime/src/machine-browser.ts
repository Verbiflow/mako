import { spawn, type ChildProcess } from "node:child_process"
import { statfsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { LocalBrowser } from "./browser-discovery.js"

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
  /** Each Chromium once it answers, for a registry that ends what a crashed host left running. */
  started?: (child: ChildProcess) => void
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
    this.#child?.kill("SIGTERM")
    this.#child = undefined
  }

  #endpoint(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("The machine's browser is shutting down"))
    this.#starting ??= this.#launch().catch((error: Error) => {
      this.#starting = undefined
      throw error
    })
    return this.#starting
  }

  async #launch(): Promise<string> {
    const { executable, profile, sandbox = true, startupMs = 30_000, window = { width: 1280, height: 800 } } = this.#options
    await mkdir(profile, { recursive: true, mode: 0o700 })
    // A profile left by a Chromium that was killed names a port nobody listens on.
    await rm(join(profile, "DevToolsActivePort"), { force: true })
    if (this.#closed) throw new Error("The machine's browser is shutting down")
    const child = spawn(executable, [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${window.width},${window.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...(sharedMemory() < SHARED_MEMORY_FLOOR ? ["--disable-dev-shm-usage"] : []),
      ...(sandbox ? [] : ["--no-sandbox"]),
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] })
    this.#child = child
    child.once("exit", () => {
      if (this.#child !== child) return
      this.#child = undefined
      this.#starting = undefined
    })
    let output = ""
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Chromium didn't start within ${startupMs / 1000} s`)), startupMs)
        const settle = () => {
          clearTimeout(timer)
          child.stderr.off("data", read)
          child.off("exit", exited)
          child.off("error", failed)
        }
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192)
          const endpoint = LISTENING.exec(output)?.[1]
          if (!endpoint) return
          settle()
          this.#options.started?.(child)
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
        child.stderr.on("data", read)
        child.once("exit", exited)
        child.once("error", failed)
      })
    } catch (error) {
      child.kill("SIGKILL")
      throw error
    } finally {
      // Its later output is never read, so the pipe must not fill and stall it.
      child.stderr.resume()
    }
  }
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
