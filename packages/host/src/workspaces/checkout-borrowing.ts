import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { Git } from "@mako/git"
import type { BorrowAnswer, BorrowPush, Borrower, Grant, Kind, Mode, Need, Refusal, SourceAnswer, SourceAsk } from "@mako/protocol/borrow"
import { LocalBorrowing, type LocalBorrowingOptions } from "./local-borrowing.js"
import { LINKED_MARK, bringFiles, carryFiles, matchedEntries, type BringEntry, type BringReport } from "./worktree-carry.js"
import type { CarryEntry } from "./thread-recipe.js"

/**
 * A worktree's files from its project's main checkout, as borrowing: the recipe's `carry` and `worktree_bring` are
 * needs of the worktree's Thread, decided by this device's broker under its grants, and each entry placed is a lease.
 * Revoking the grant removes what it placed from every worktree; the lease log says what each worktree took and when.
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

/** Where a lease placed its entry, so its end can take it away again. */
type Placed = { lease: string; checkout: string; root: string; entry: string; link: boolean; thread: string; generation: number }

/** What the source says of an entry of a main checkout: a version from what it is now, never what it holds. */
export async function checkoutSource(ask: SourceAsk): Promise<SourceAnswer> {
  const root = ask.borrower.repository
  const path = join(root, ask.ref)
  const real = await realpath(path).catch(() => undefined)
  if (!real) return { answer: "unavailable", detail: `${ask.ref} isn't in the main checkout` }
  const inner = relative(await realpath(root).catch(() => root), real)
  if (inner.startsWith("..") || isAbsolute(inner)) return { answer: "unavailable", detail: `${ask.ref} points outside the main checkout` }
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
    case "unavailable":
      return `${entry}: ${refusal.detail}`
  }
}

export interface CheckoutBorrowingOptions {
  borrowing: LocalBorrowing
  git: Git
  /** Where the index of what was placed lives; none keeps it in memory. */
  folder?: string
}

export class CheckoutBorrowing {
  readonly borrowing: LocalBorrowing
  readonly #git: Git
  readonly #folder: string | undefined
  #placed: Map<string, Placed> | undefined
  #seeded: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: CheckoutBorrowingOptions) {
    this.borrowing = options.borrowing
    this.#git = options.git
    this.#folder = options.folder
    this.borrowing.onPush((borrower, push) => void this.#heard(borrower, push))
  }

  /** In memory, for a host or a test that keeps nothing: the same grants and decisions. */
  static inMemory(git: Git): CheckoutBorrowing {
    return CheckoutBorrowing.open(git)
  }

  /** This device's, keeping its grants, its log and what it placed in `folder`. */
  static open(git: Git, folder?: string): CheckoutBorrowing {
    const options: LocalBorrowingOptions = { device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, source: checkoutSource }
    if (folder) options.folder = folder
    const borrowing = new LocalBorrowing(options)
    return new CheckoutBorrowing(folder ? { git, borrowing, folder } : { git, borrowing })
  }

  /** The device's checkout grants, offered at version 1: the broker takes each once, and one the person revoked stays revoked. */
  seed(): Promise<void> {
    this.#seeded ??= (async () => {
      for (const grant of checkoutGrants(this.borrowing.device, this.borrowing.account, Date.now())) await this.borrowing.grant(grant)
    })()
    return this.#seeded
  }

  /** The recipe's carry into a new worktree: each entry the grants allow, copied or linked; returns how many came. */
  async carry(thread: string, repoRoot: string, checkout: string, entries: readonly CarryEntry[]): Promise<{ copied: number; refused: string[] }> {
    const { granted, refused } = await this.#decide(thread, repoRoot, checkout, entries.map((entry) => ({ path: entry.path, link: Boolean(entry.link) })), "the recipe's carry")
    const copied = granted.length ? await carryFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link }))) : 0
    return { copied, refused }
  }

  /** `worktree_bring`: the entries asked for, each under a lease, with what was refused and why. */
  async bring(thread: string, repoRoot: string, checkout: string, entries: readonly BringEntry[]): Promise<BringReport & { refused: string[] }> {
    const asked = entries.map((entry) => ({ path: entry.path, link: Boolean(entry.link) }))
    const { granted, refused, missing } = await this.#decide(thread, repoRoot, checkout, asked, "worktree_bring")
    const report = granted.length ? await bringFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link }))) : { copied: [], linked: [], owned: [], existing: [], missing: [] }
    report.missing.push(...missing)
    return { ...report, refused }
  }

  /** The worktree is gone: every lease it held ends, released. */
  async forget(checkout: string): Promise<void> {
    const placed = await this.#index()
    for (const item of [...placed.values()].filter((held) => held.checkout === checkout)) {
      await this.borrowing.release(item.lease)
      placed.delete(item.lease)
    }
    await this.#saveIndex()
  }

  /** Renews what each worktree holds, takes again what lapsed while the device was off, and removes what was revoked. */
  async keep(): Promise<void> {
    await this.borrowing.tick()
    await this.#queue
    const held = Array.from((await this.#index()).values())
    for (const item of held) {
      const answer = await this.borrowing.renew(item.lease)
      if ("lease" in answer) continue
      if ("refusal" in answer && answer.refusal.refused === "expired") await this.#again(item)
      else await this.#unplace(item)
    }
  }

  async #decide(thread: string, repoRoot: string, checkout: string, asked: ReadonlyArray<{ path: string; link: boolean }>, why: string) {
    await this.seed()
    const root = await realpath(repoRoot).catch(() => repoRoot)
    const granted: Array<{ entry: string; link: boolean }> = []
    const refused: string[] = []
    const missing: string[] = []
    for (const request of asked) {
      const matches = await matchedEntries(this.#git, repoRoot, [request.path])
      if (!matches.length) missing.push(request.path)
      for (const entry of matches) {
        const kind: Kind = (await lstat(join(repoRoot, entry)).catch(() => undefined))?.isDirectory() ? "tree" : "file"
        const answer = await this.#borrow(thread, root, checkout, entry, kind, request.link, why, 0)
        if ("lease" in answer) granted.push({ entry, link: request.link })
        else if ("refusal" in answer) refused.push(refusalText(entry, answer.refusal))
        else refused.push(`${entry}: waiting on the person`)
      }
    }
    return { granted, refused, missing }
  }

  async #borrow(thread: string, root: string, checkout: string, entry: string, kind: Kind, link: boolean, why: string, generation: number): Promise<BorrowAnswer> {
    const borrower: Borrower = { account: this.borrowing.account, repository: root, thread, place: { kind: "device", device: this.borrowing.device } }
    const correlationId = createHash("sha256").update(`${checkout}\0${entry}\0${link}\0${generation}`).digest("hex").slice(0, 32)
    const need: Need = { kind, ref: entry, for: borrower, why, correlationId, mode: link ? "live" : "copy" }
    const answer = await this.borrowing.borrow(need)
    if ("lease" in answer) {
      const placed = await this.#index()
      placed.set(answer.lease.id, { lease: answer.lease.id, checkout, root, entry, link, thread, generation })
      await this.#saveIndex()
    }
    return answer
  }

  async #again(item: Placed): Promise<void> {
    const placed = await this.#index()
    placed.delete(item.lease)
    const kind: Kind = (await lstat(join(item.root, item.entry)).catch(() => undefined))?.isDirectory() ? "tree" : "file"
    const answer = await this.#borrow(item.thread, item.root, item.checkout, item.entry, kind, item.link, "kept while its worktree is", item.generation + 1)
    if (!("lease" in answer)) await this.#unplace(item)
    await this.#saveIndex()
  }

  /** A revoked lease's placement goes at once; one that lapsed is taken again by the next `keep`. */
  async #heard(borrower: Borrower, push: BorrowPush): Promise<void> {
    if (push.push !== "ended" || push.why !== "revoked" || borrower.place.kind !== "device" || borrower.place.device !== this.borrowing.device) return
    this.#queue = this.#queue.then(async () => {
      const item = (await this.#index()).get(push.lease)
      if (item) await this.#unplace(item)
    }).catch(() => undefined)
    await this.#queue
  }

  /** What a lease placed, taken away: a link, a linked folder's links to the main checkout, or a copy. */
  async #unplace(item: Placed): Promise<void> {
    const placed = await this.#index()
    placed.delete(item.lease)
    await this.#saveIndex()
    const path = join(item.checkout, item.entry)
    const info = await lstat(path).catch(() => undefined)
    if (!info) return
    const source = join(item.root, item.entry)
    if (info.isSymbolicLink()) {
      if ((await readlink(path).catch(() => "")) === source || !item.link) await rm(path, { force: true })
      return
    }
    if (item.link && info.isDirectory()) {
      const mark = (await readFile(join(path, LINKED_MARK), "utf8").catch(() => "")).trim()
      if (!mark) return
      for (const name of await readdir(path)) {
        const inner = join(path, name)
        if (name === LINKED_MARK || (await readlink(inner).catch(() => "")).startsWith(source)) await rm(inner, { force: true })
      }
      return
    }
    if (!item.link) await rm(path, { recursive: true, force: true })
  }

  async #index(): Promise<Map<string, Placed>> {
    if (this.#placed) return this.#placed
    const text = this.#folder ? await readFile(join(this.#folder, "placed.json"), "utf8").catch(() => "") : ""
    // SAFETY: only #saveIndex writes this file, whole and by rename, from these entries.
    const saved = text ? (JSON.parse(text) as Placed[]) : []
    this.#placed = new Map(saved.map((item) => [item.lease, item]))
    return this.#placed
  }

  async #saveIndex(): Promise<void> {
    if (!this.#folder || !this.#placed) return
    const path = join(this.#folder, "placed.json")
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(this.#folder, `.placed.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify([...this.#placed.values()]), { mode: 0o600 })
    await rename(temporary, path)
  }
}
