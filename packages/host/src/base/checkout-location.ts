import { readFile, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { LinkedCheckout } from "../contracts/checkout-heads.js"

async function readText(path: string): Promise<string | null> {
  return readFile(path, "utf8").then((text) => text.trim(), () => null)
}

/**
 * macOS reaches /tmp, /var and /etc through /private. Git records the
 * /private spelling; harnesses and shells mostly don't. A repository is
 * named the way the folder asked about names things.
 */
export function spelledLike(path: string, folder: string): string {
  const privateFolder = folder.startsWith("/private/")
  if (path.startsWith("/private/")) return privateFolder ? path : path.slice("/private".length)
  return privateFolder && /^\/(tmp|var|etc)\//.test(path) ? `/private${path}` : path
}

export interface CheckoutLocation {
  gitDir: string
  linked?: LinkedCheckout
}

/**
 * The checkout a `.git` file at `dir` points to, given its `commondir` file
 * (null when there is none). Only a linked worktree's Git directory has a
 * `commondir`; a submodule's `.git` file points too, without one.
 */
export function pointedCheckout(dir: string, gitDir: string, common: string | null): CheckoutLocation {
  if (!common) return { gitDir }
  const commonDir = resolve(gitDir, common)
  return { gitDir, linked: { path: dir, repoRoot: spelledLike(basename(commonDir) === ".git" ? dirname(commonDir) : commonDir, dir) } }
}

export function gitDirPointer(dir: string, pointer: string | null): string | null {
  return pointer?.startsWith("gitdir: ") ? resolve(dir, pointer.slice("gitdir: ".length)) : null
}

/**
 * The checkout holding `folder`: its Git directory (`.git` itself, or where a
 * `.git` file points), and for a linked worktree where it sits and whose it
 * is.
 */
export async function locateCheckout(folder: string): Promise<CheckoutLocation | null> {
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git")
    const info = await stat(dotGit).catch(() => null)
    if (info?.isDirectory()) return { gitDir: dotGit }
    if (info?.isFile()) {
      const gitDir = gitDirPointer(dir, await readText(dotGit))
      return gitDir ? pointedCheckout(dir, gitDir, await readText(join(gitDir, "commondir"))) : null
    }
    if (dirname(dir) === dir) return null
  }
}

export async function locateGitDir(folder: string): Promise<string | null> {
  return (await locateCheckout(folder))?.gitDir ?? null
}
