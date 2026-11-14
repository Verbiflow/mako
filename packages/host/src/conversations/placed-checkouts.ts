import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { Git } from "@mako/git"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"

/** How long a clone for a placed Fin may take before it's given up. */
const CLONE_MS = 15 * 60_000

export interface PlacedCheckoutsDeps {
  git: Git
  /** Where this device clones a project it has no checkout of. */
  projects: string
  /** Folders this device already works in (its Threads' project folders), each maybe a checkout of the remote asked for. */
  known(): readonly string[]
}

/**
 * A Git remote as two spellings of it compare: its host without case and its path without `.git`, whatever the
 * transport (`git@host:owner/repo.git`, `https://host/owner/repo`, `ssh://git@host/owner/repo`); a path on this
 * machine as it is.
 */
export function remoteKey(remote: string): string {
  const text = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "")
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text)
  if (scp && !text.includes("://")) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`.toLowerCase()
  try {
    const url = new URL(text)
    if (url.protocol === "file:") return `file:${decodeURIComponent(url.pathname)}`
    if (url.hostname) return `${url.hostname}${url.pathname}`.toLowerCase()
  } catch {
    // Not a URL: a path, compared as written.
  }
  return `file:${text}`
}

/**
 * The checkout a Fin placed here works in a worktree of: one this device has of the project's Git remote (a clone it
 * made before, or a folder one of its Threads works in), else a clone it makes in its projects folder. A clone is made
 * beside its final name and renamed there once whole, so one cut short is never taken for a checkout.
 */
export class PlacedCheckouts {
  private readonly deps: PlacedCheckoutsDeps
  /** Clones under way, by remote: a second Fin of the same project waits for the first's. */
  private readonly cloning = new Map<string, Promise<{ folder: string } | { refused: string }>>()

  constructor(deps: PlacedCheckoutsDeps) {
    this.deps = deps
  }

  async find(remote: string): Promise<{ folder: string } | { refused: string }> {
    const key = remoteKey(remote)
    const held = await this.held(key)
    if (held) return { folder: held }
    const under = this.cloning.get(key)
    if (under) return under
    const clone = this.clone(remote, key).finally(() => this.cloning.delete(key))
    this.cloning.set(key, clone)
    return clone
  }

  /** A checkout of the remote this device has: its own clones first, then the folders its Threads work in. */
  private async held(key: string): Promise<string | undefined> {
    const clones = await readdir(this.deps.projects, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory() && !entry.name.includes(".cloning-")).map((entry) => join(this.deps.projects, entry.name)),
      () => [])
    const seen = new Set<string>()
    for (const folder of [...clones, ...this.deps.known()]) {
      const root = await this.mainCheckout(folder)
      if (!root || seen.has(root)) continue
      seen.add(root)
      const origin = await this.deps.git.output(root, ["remote", "get-url", "origin"]).then((text) => text.trim(), () => "")
      if (origin && remoteKey(origin) === key) return root
    }
    return undefined
  }

  /** The main checkout `folder` belongs to: itself, or the one a linked worktree was added to; undefined outside a repository. */
  private async mainCheckout(folder: string): Promise<string | undefined> {
    const common = await this.deps.git.output(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then((text) => text.trim(), () => "")
    if (!common) return undefined
    return basename(common) === ".git" ? dirname(common) : undefined
  }

  private async clone(remote: string, key: string): Promise<{ folder: string } | { refused: string }> {
    const began = performance.now()
    const name = (key.split("/").at(-1) ?? "project").replace(/[^A-Za-z0-9._-]/g, "-") || "project"
    try {
      await mkdir(this.deps.projects, { recursive: true })
      let folder = join(this.deps.projects, name)
      for (let n = 2; await stat(folder).then(() => true, () => false); n += 1) folder = join(this.deps.projects, `${name}-${n}`)
      const making = `${folder}.cloning-${process.pid}`
      await rm(making, { recursive: true, force: true })
      try {
        await this.deps.git.run({ cwd: this.deps.projects, args: ["clone", "--quiet", "--", remote, making], timeoutMs: CLONE_MS })
        await rename(making, folder)
      } catch (error) {
        await rm(making, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      hostLog("agents", "cloned a project for a placed Fin", { remote: key, folder, ms: Math.round(performance.now() - began) })
      return { folder }
    } catch (error) {
      hostWarn("agents", "a project couldn't be cloned for a placed Fin", { remote: key, error: errorMessage({ error }) })
      return { refused: `git clone failed (${errorMessage({ error })}). Clone it on this device, or give this device access to the remote.` }
    }
  }
}
