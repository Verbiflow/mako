import { execFile } from "node:child_process"
import { existsSync, readlinkSync } from "node:fs"
import { availableParallelism } from "node:os"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { belowAgents } from "./background-priority.js"

const execute = promisify(execFile)
const GitFailureSchema = z.object({ stderr: z.string() })

/**
 * The Git binary itself. On macOS `/usr/bin/git` is a shim that looks up the
 * developer tools on every run: 12 ms a call against 4.6 ms for the binary it
 * finds. The tools `xcode-select` chose are a symlink away, so resolving
 * them spawns nothing. A Git earlier on PATH (Homebrew's) is used as is.
 */
function resolveGit(): string {
  if (process.platform !== "darwin") return "git"
  const first = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))
  if (first && first !== "/usr/bin/git") return first
  const developer = process.env.DEVELOPER_DIR || (() => {
    try {
      return readlinkSync("/var/db/xcode_select_link")
    } catch {
      return "/Library/Developer/CommandLineTools"
    }
  })()
  const tools = join(developer, "usr", "bin", "git")
  return existsSync(tools) ? tools : first ?? "git"
}

let resolved: string | undefined
export function gitExecutable(): string {
  resolved ??= resolveGit()
  return resolved
}

export class GitError extends Error {
  readonly stderr: string
  constructor(stderr: string, cause: unknown) {
    super(stderr.trim() || "git failed", { cause })
    this.name = "GitError"
    this.stderr = stderr.trim()
  }
}

/** `background` runs it below the agents already working (see `belowAgents`). */
export async function git(cwd: string, args: string[], background = false): Promise<string> {
  const [command, argv] = background ? belowAgents(gitExecutable(), args) : [gitExecutable(), args]
  try {
    const { stdout } = await execute(command, argv, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    throw new GitError(GitFailureSchema.safeParse(error).data?.stderr ?? "", error)
  }
}

export function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true, () => false)
}

/**
 * Git's parallel checkout. APFS spends extra workers on contention past four;
 * Linux filesystems keep gaining to about eight (50,000 files: one worker
 * 10-20 s, these 2-5 s, for about the same CPU).
 */
const CHECKOUT_WORKERS = Math.min(process.platform === "darwin" ? 4 : 8, availableParallelism())
export const PARALLEL_CHECKOUT = ["-c", `checkout.workers=${CHECKOUT_WORKERS}`, "-c", "checkout.thresholdForParallelism=100"]
