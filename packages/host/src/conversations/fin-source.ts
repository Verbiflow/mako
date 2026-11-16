import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Git } from "@mako/git"
import { CommittedFinSourceSchema, type CommittedFinSource } from "../contracts/fin-source.js"
import { githubRepositoryUrl } from "../contracts/cloud-threads.js"

/** Fixed failure categories, never Git output (which may contain an authenticated remote). */
export class FinSourceError extends Error {
  readonly reason: "unavailable" | "remote" | "dirty" | "unpublished" | "changed" | "digest" | "checkout" | "cwd" | "unsupported"
  constructor(reason: FinSourceError["reason"]) {
    super(`The Fin's committed source could not be verified (${reason}).`)
    this.reason = reason
  }
}

/** Canonical field order is independent of JSON member order at either host. This is identity, not authority. */
export function sealFinSource(source: Omit<CommittedFinSource, "sha256">): CommittedFinSource {
  const checked = CommittedFinSourceSchema.parse({ ...source, sha256: "0".repeat(64) })
  const body = { version: checked.version, repository: { url: checked.repository.url, ...(checked.repository.branch && { branch: checked.repository.branch }) }, commit: checked.commit, cwd: checked.cwd }
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") }
}

export function checkedFinSource(source: CommittedFinSource): CommittedFinSource {
  const parsed = CommittedFinSourceSchema.safeParse(source)
  if (!parsed.success || sealFinSource(parsed.data).sha256 !== parsed.data.sha256) throw new FinSourceError("digest")
  return parsed.data
}

/** Each inspection is bounded and output truncation is a refusal, not partial evidence. */
async function read(git: Git, cwd: string, args: readonly string[], codes?: readonly number[]): Promise<string> {
  try {
    const result = await git.run({ cwd, args, codes, read: true, timeoutMs: 15_000, maxBytes: 4 * 1024 ** 2, env: { GIT_TERMINAL_PROMPT: "0" } })
    if (result.truncated) throw new FinSourceError("unavailable")
    return result.stdout.toString("utf8").trim()
  } catch { throw new FinSourceError("unavailable") }
}

async function clean(git: Git, root: string): Promise<void> {
  if (await read(git, root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) throw new FinSourceError("dirty")
  const files = await read(git, root, ["ls-files", "--stage", "-v"])
  if (files.split("\n").some(row => /^[a-zS] /.test(row) || /^\S 160000 /.test(row))) throw new FinSourceError("unsupported")
}

/** Read the actual Apex checkout. A local-only commit or dirty tree needs a different, explicit source choice. */
export async function captureFinSource(git: Git, folder: string): Promise<CommittedFinSource> {
  const cwd = await realpath(folder).catch(() => { throw new FinSourceError("cwd") })
  const root = await realpath(await read(git, cwd, ["rev-parse", "--show-toplevel"]))
  const commit = await read(git, root, ["rev-parse", "--verify", "HEAD^{commit}"])
  // Keep the logical origin, not a machine-specific url.insteadOf expansion.
  const url = githubRepositoryUrl(await read(git, root, ["config", "--get", "remote.origin.url"]))
  if (!url) throw new FinSourceError("remote")
  await clean(git, root)
  const branch = await read(git, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])
  const under = relative(root, cwd)
  if (isAbsolute(under) || under === ".." || under.startsWith(`..${sep}`)) throw new FinSourceError("cwd")
  const source = sealFinSource({ version: 1, repository: { url, ...(branch && { branch }) }, commit, cwd: under.split(sep).join("/") || "." })
  // Only a published tip is accepted in this first slice. Detached HEAD can match any advertised head/tag.
  const refs = await read(git, root, ["ls-remote", "--heads", "--tags", "origin", ...(branch ? [`refs/heads/${branch}`] : [])])
  if (!refs.split("\n").some(row => row.split(/\s+/)[0] === commit)) throw new FinSourceError("unpublished")
  if (await read(git, root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== commit) throw new FinSourceError("changed")
  if (githubRepositoryUrl(await read(git, root, ["config", "--get", "remote.origin.url"])) !== url) throw new FinSourceError("changed")
  await clean(git, root)
  return source
}

/** Normal placement's final source gate. It never switches a shared checkout or silently follows a moved branch. */
export async function verifyFinSource(git: Git, folder: string, input: CommittedFinSource): Promise<string> {
  const source = checkedFinSource(input)
  const root = await realpath(folder).catch(() => { throw new FinSourceError("cwd") })
  if (await realpath(await read(git, root, ["rev-parse", "--show-toplevel"])) !== root) throw new FinSourceError("cwd")
  const remote = githubRepositoryUrl(await read(git, root, ["config", "--get", "remote.origin.url"]))
  if (remote !== source.repository.url || await read(git, root, ["rev-parse", "--verify", "HEAD^{commit}"]) !== source.commit) throw new FinSourceError("checkout")
  await clean(git, root)
  const cwd = await realpath(resolve(root, source.cwd)).catch(() => { throw new FinSourceError("cwd") })
  if (!(await stat(cwd)).isDirectory()) throw new FinSourceError("cwd")
  const under = relative(root, cwd)
  if (isAbsolute(under) || under === ".." || under.startsWith(`..${sep}`)) throw new FinSourceError("cwd")
  return cwd
}
