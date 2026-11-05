import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, readlink, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { Git } from "@mako/git"
import type { BorrowAnswer, BorrowPush, Borrower, Grant, Kind, Mode, Need, Refusal, SourceAnswer, SourceAsk } from "@mako/protocol/borrow"
import { LocalBorrowing, type LocalBorrowingOptions, type SourceFn } from "../base/local-borrowing.js"
import { LINKED_MARK, bringFiles, carryFiles, matchedEntries, type BringEntry, type BringReport } from "./worktree-carry.js"
import type { CarryEntry } from "./thread-recipe.js"

/**
 * A worktree's files from its project's main checkout, as borrowing: the recipe's `carry` and `worktree_bring` are
 * needs of the worktree's Thread, decided by this device's broker under its grants, and each entry Mako places is a
 * lease. Revoking the grant takes what Mako placed out of every worktree; the lease log says what each worktree took
 * and when.
 *
 * Mako removes only what it made: each placement is recorded once it has landed, with what it was (a copy's file, a
 * link's target), and a removal deletes a path only while it's still that. A file the worktree already had, or one
 * put in place of Mako's since, is never touched. A removal is written down before it starts and crossed off once
 * it's done, so one cut short by a crash or a failed delete is taken up again.
 *
 * Every device starts with two grants that keep to it: the files Git ignores in its main checkouts, copied or
 * linked, for its own Threads. They are what a worktree had before borrowing; the person can revoke either, or give
 * narrower ones. Whether a file holds a secret is the grant's to say, never its name's.
 */
export const CHECKOUT_GRANTS = { copy: "device-checkouts-copy", live: "device-checkouts-live" } as const
/** How this device's own broker names the device and its account: it serves only borrowers here, whoever is signed in. */
export const LOCAL_DEVICE = "this-device"
export const LOCAL_ACCOUNT = "local"

export function checkoutGrants(device: string, account: string, at: number): Grant[] {
  const grant = (id: string, mode: Mode, label: string): Grant => ({
    id,
    resource: { kind: "tree", ref: "**" },
    source: { kind: "device", device },
    scope: { level: "account", account },
    within: "source-device",
    mode,
    access: "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    label,
    grantedBy: { kind: "mako" },
    grantedAt: at,
    version: 1,
  })
  return [
    grant(CHECKOUT_GRANTS.copy, "copy", "Files Git ignores in this device's main checkouts, copied into its worktrees"),
    grant(CHECKOUT_GRANTS.live, "live", "Files Git ignores in this device's main checkouts, linked into its worktrees"),
  ]
}

/** What Mako made at a path: a copy (its file, by device and inode), or a link (a symlink to the source, or a folder of links marked as Mako's). */
type Made = { kind: "copy"; dev: number; ino: number } | { kind: "link" } | { kind: "linked-folder" }

/** A placement: the lease, where it landed and what Mako made there; `removing` once its removal has begun. */
type Placed = { lease: string; checkout: string; root: string; entry: string; link: boolean; thread: string; generation: number; made: Made; removing?: true }

/** What the source says of an entry of a main checkout: a version from what it is now, never what it holds. */
export async function checkoutSource(ask: SourceAsk): Promise<SourceAnswer> {
  const root = ask.borrower.repository
  const real = await realpath(join(root, ask.ref)).catch(() => undefined)
  if (!real) return { answer: "unavailable", reason: "not-found" }
  const inner = relative(await realpath(root).catch(() => root), real)
  if (inner.startsWith("..") || isAbsolute(inner)) return { answer: "unavailable", reason: "outside" }
  const info = await lstat(real)
  const version = createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`).digest("hex")
  return info.isFile() ? { answer: "yes", version, size: info.size } : { answer: "yes", version }
}

/** A refusal in the words a person reads. */
export function refusalText(entry: string, refusal: Refusal): string {
  switch (refusal.refused) {
    case "no-grant":
      return `${entry}: nothing grants this worktree files from the main checkout; the person can allow it in Setup`
    case "out-of-scope":
      return `${entry}: this device's grant doesn't reach this Thread`
    case "revoked":
      return `${entry}: the grant for it was revoked`
    case "expired":
      return `${entry}: the grant for it has lapsed`
    case "declined":
      return `${entry}: the person declined it`
    case "source-offline":
      return `${entry}: its source is offline`
    case "too-large":
      return `${entry}: it's larger than a lease carries`
    case "thread-ended":
      return `${entry}: this Thread has ended`
    case "unavailable":
      return `${entry}: ${refusal.reason === "not-found" ? "it isn't in the main checkout" : refusal.reason === "outside" ? "it points outside the main checkout" : "the main checkout couldn't give it"}`
  }
}

export interface CheckoutBorrowingOptions {
  borrowing: LocalBorrowing
  git: Git
  /** How a placement is deleted; a test fails it on purpose. */
  remove?: (path: string, recursive: boolean) => Promise<void>
}

/** The sources a checkout broker answers for, to give any other broker over the same folder. */
export const CHECKOUT_SOURCES = { file: checkoutSource, tree: checkoutSource } satisfies Partial<Record<Kind, SourceFn>>

export class CheckoutBorrowing {
  readonly borrowing: LocalBorrowing
  readonly #git: Git
  readonly #remove: (path: string, recursive: boolean) => Promise<void>
  #memory: Placed[] = []
  #seeded: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: CheckoutBorrowingOptions) {
    this.borrowing = options.borrowing
    this.#git = options.git
    this.#remove = options.remove ?? ((path, recursive) => rm(path, { recursive, force: true }))
    this.borrowing.onPush((borrower, push) => void this.#heard(borrower, push))
  }

  /** In memory, for a host or a test that keeps nothing: the same grants and decisions. */
  static inMemory(git: Git): CheckoutBorrowing {
    return CheckoutBorrowing.open(git)
  }

  /** This device's, keeping its grants, its log and what it placed in `folder`, with any other sources that folder's brokers serve. */
  static open(git: Git, folder?: string, more: Partial<Record<Kind, SourceFn>> = {}, remove?: CheckoutBorrowingOptions["remove"]): CheckoutBorrowing {
    const options: LocalBorrowingOptions = { device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, sources: { ...more, ...CHECKOUT_SOURCES } }
    if (folder) options.folder = folder
    const made: CheckoutBorrowingOptions = { git, borrowing: new LocalBorrowing(options) }
    if (remove) made.remove = remove
    return new CheckoutBorrowing(made)
  }

  /** The device's checkout grants, offered at version 1: the broker takes each once, and one the person revoked stays revoked. */
  seed(): Promise<void> {
    this.#seeded ??= (async () => {
      for (const grant of checkoutGrants(this.borrowing.device, this.borrowing.account, Date.now())) await this.borrowing.grant(grant)
    })()
    return this.#seeded
  }

  /** The recipe's carry into a new worktree: each entry the grants allow and the worktree doesn't have, copied or linked. */
  async carry(thread: string, repoRoot: string, checkout: string, entries: readonly CarryEntry[]): Promise<{ copied: number; refused: string[] }> {
    const { granted, refused } = await this.#decide(thread, repoRoot, checkout, entries.map((entry) => ({ path: entry.path, link: Boolean(entry.link) })), "the recipe's carry")
    const placed = granted.length ? await carryFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link }))) : []
    await this.#settle(granted, placed)
    return { copied: placed.length, refused }
  }

  /** `worktree_bring`: the entries asked for, each under a lease, with what was refused and why. */
  async bring(thread: string, repoRoot: string, checkout: string, entries: readonly BringEntry[]): Promise<BringReport & { refused: string[] }> {
    const asked = entries.map((entry) => ({ path: entry.path, link: Boolean(entry.link) }))
    const { granted, refused, missing } = await this.#decide(thread, repoRoot, checkout, asked, "worktree_bring")
    const report = granted.length ? await bringFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link }))) : { copied: [], linked: [], owned: [], existing: [], missing: [] }
    // A linked entry made the worktree's own is Mako's copy now, in place of Mako's link.
    await this.#settle(granted, [...report.copied, ...report.linked, ...report.owned])
    report.missing.push(...missing)
    return { ...report, refused }
  }

  /** The worktree is gone: every lease it held ends, released. */
  async forget(checkout: string): Promise<void> {
    const gone = await this.#edit((placed) => ({ keep: placed.filter((item) => item.checkout !== checkout), value: placed.filter((item) => item.checkout === checkout) }))
    for (const item of gone) await this.borrowing.release(item.lease)
  }

  /**
   * Finishes removals cut short, renews what each worktree holds, takes again what lapsed while the device was off,
   * and removes what was revoked, from this broker or another over the same folder.
   */
  async keep(): Promise<void> {
    await this.borrowing.tick()
    await this.#queue
    for (const item of await this.#placed()) {
      try {
        if (item.removing) {
          await this.#unplace(item)
          continue
        }
        const answer = await this.borrowing.renew(item.lease)
        if ("lease" in answer) continue
        if ("refusal" in answer && answer.refusal.refused === "expired") await this.#again(item)
        else await this.#unplace(item)
      } catch {
        // Its removal stays written down, and the next keep takes it up again.
      }
    }
  }

  async #decide(thread: string, repoRoot: string, checkout: string, asked: ReadonlyArray<{ path: string; link: boolean }>, why: string) {
    await this.seed()
    const root = await realpath(repoRoot).catch(() => repoRoot)
    const granted: Array<{ entry: string; link: boolean; lease: string; thread: string; root: string; checkout: string; generation: number }> = []
    const refused: string[] = []
    const missing: string[] = []
    for (const request of asked) {
      const matches = await matchedEntries(this.#git, repoRoot, [request.path])
      if (!matches.length) missing.push(request.path)
      for (const entry of matches) {
        const kind: Kind = (await lstat(join(repoRoot, entry)).catch(() => undefined))?.isDirectory() ? "tree" : "file"
        const answer = await this.#borrow(thread, root, checkout, entry, kind, request.link, why, 0)
        if ("lease" in answer) granted.push({ entry, link: request.link, lease: answer.lease.id, thread, root, checkout, generation: 0 })
        else if ("refusal" in answer) refused.push(refusalText(entry, answer.refusal))
        else refused.push(`${entry}: waiting on the person`)
      }
    }
    return { granted, refused, missing }
  }

  /** Each granted entry that landed is recorded with what Mako made; one that didn't (the worktree had it) is released. */
  async #settle(granted: ReadonlyArray<{ entry: string; link: boolean; lease: string; thread: string; root: string; checkout: string; generation: number }>, placedEntries: readonly string[]): Promise<void> {
    const landed: Placed[] = []
    for (const item of granted) {
      if (!placedEntries.includes(item.entry)) {
        if (!(await this.#placed()).some((held) => held.lease === item.lease)) await this.borrowing.release(item.lease)
        continue
      }
      const made = await this.#made(join(item.checkout, item.entry), item.link)
      if (made) landed.push({ lease: item.lease, checkout: item.checkout, root: item.root, entry: item.entry, link: item.link, thread: item.thread, generation: item.generation, made })
    }
    if (landed.length) await this.#edit((placed) => ({ keep: [...placed.filter((held) => !landed.some((item) => item.lease === held.lease || (item.checkout === held.checkout && item.entry === held.entry))), ...landed], value: undefined }))
  }

  async #made(path: string, link: boolean): Promise<Made | undefined> {
    const info = await lstat(path).catch(() => undefined)
    if (!info) return undefined
    if (link && info.isSymbolicLink()) return { kind: "link" }
    if (link && info.isDirectory()) return { kind: "linked-folder" }
    return { kind: "copy", dev: info.dev, ino: info.ino }
  }

  async #borrow(thread: string, root: string, checkout: string, entry: string, kind: Kind, link: boolean, why: string, generation: number): Promise<BorrowAnswer> {
    const borrower: Borrower = { account: this.borrowing.account, repository: root, thread, place: { kind: "device", device: this.borrowing.device } }
    const correlationId = createHash("sha256").update(`${checkout}\0${entry}\0${link}\0${generation}`).digest("hex").slice(0, 32)
    const need: Need = { kind, ref: entry, for: borrower, why, correlationId, mode: link ? "live" : "copy" }
    return this.borrowing.borrow(need)
  }

  async #again(item: Placed): Promise<void> {
    const kind: Kind = (await lstat(join(item.root, item.entry)).catch(() => undefined))?.isDirectory() ? "tree" : "file"
    const answer = await this.#borrow(item.thread, item.root, item.checkout, item.entry, kind, item.link, "kept while its worktree is", item.generation + 1)
    if (!("lease" in answer)) {
      await this.#unplace(item)
      return
    }
    const lease = answer.lease.id
    await this.#edit((placed) => ({ keep: placed.map((held) => (held.lease === item.lease ? { ...held, lease, generation: item.generation + 1 } : held)), value: undefined }))
  }

  /** A revoked lease's placement goes at once; one that lapsed is taken again by the next `keep`. */
  async #heard(borrower: Borrower, push: BorrowPush): Promise<void> {
    if (push.push !== "ended" || push.why !== "revoked" || borrower.place.kind !== "device" || borrower.place.device !== this.borrowing.device) return
    this.#queue = this.#queue.then(async () => {
      const item = (await this.#placed()).find((held) => held.lease === push.lease)
      if (item) await this.#unplace(item)
    }).catch(() => undefined)
    await this.#queue
  }

  /**
   * What a lease placed, taken away only while it's still what Mako made: a copy is the same file, a link still
   * leads into the main checkout's entry, a linked folder still has Mako's mark (and only its links go). The removal
   * is written down first and crossed off after, so a delete that fails or is cut short is done by the next `keep`.
   */
  async #unplace(item: Placed): Promise<void> {
    await this.#edit((placed) => ({ keep: placed.map((held) => (held.lease === item.lease ? { ...held, removing: true as const } : held)), value: undefined }))
    const path = join(item.checkout, item.entry)
    const source = join(item.root, item.entry)
    const info = await lstat(path).catch(() => undefined)
    if (info && item.made.kind === "copy" && info.dev === item.made.dev && info.ino === item.made.ino) await this.#remove(path, info.isDirectory())
    else if (info?.isSymbolicLink() && item.made.kind === "link" && (await readlink(path).catch(() => "")) === source) await this.#remove(path, false)
    else if (info?.isDirectory() && item.made.kind === "linked-folder" && (await readFile(join(path, LINKED_MARK), "utf8").catch(() => "")).trim()) {
      for (const name of await readdir(path)) {
        const inner = join(path, name)
        if (name !== LINKED_MARK && (await readlink(inner).catch(() => "")).startsWith(source)) await this.#remove(inner, false)
      }
      await this.#remove(join(path, LINKED_MARK), false)
    }
    await this.#edit((placed) => ({ keep: placed.filter((held) => held.lease !== item.lease), value: undefined }))
  }

  async #placed(): Promise<Placed[]> {
    return this.#edit((placed) => ({ keep: placed, value: placed }))
  }

  /** The index of placements, read, changed and written back under the broker's lock. */
  #edit<T>(change: (placed: Placed[]) => { keep: Placed[]; value: T }): Promise<T> {
    const folder = this.borrowing.folder
    return this.borrowing.locked(async () => {
      // SAFETY: only this method writes the file, whole and by rename, under the folder's lock.
      const placed = folder ? (JSON.parse((await readFile(join(folder, "placed.json"), "utf8").catch(() => "")) || "[]") as Placed[]) : this.#memory
      const { keep, value } = change(placed)
      if (!folder) this.#memory = keep
      else {
        const temporary = join(folder, `.placed.${process.pid}.${randomUUID()}.tmp`)
        await writeFile(temporary, JSON.stringify(keep), { mode: 0o600 })
        await rename(temporary, join(folder, "placed.json"))
      }
      return value
    })
  }
}
