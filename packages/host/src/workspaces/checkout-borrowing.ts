import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import type { Git } from "@mako/git"
import type { BorrowAnswer, BorrowPush, Borrower, Grant, Kind, Mode, Need, Refusal, SourceAnswer, SourceAsk } from "@mako/protocol/borrow"
import { LocalBorrowing, type LocalBorrowingOptions, type SourceFn } from "../base/local-borrowing.js"
import { bringFiles, carryFiles, matchedEntries, type BringEntry, type BringReport, type Staged } from "./worktree-carry.js"
import type { CarryEntry } from "./thread-recipe.js"

/**
 * A worktree's files from its project's main checkout, as borrowing: the recipe's `carry` and `worktree_bring` are
 * needs of the worktree's Thread, decided by this device's broker under its grants, and each entry Mako places is a
 * lease. Revoking the grant takes what Mako placed out of every worktree; the lease log says what each worktree took
 * and when.
 *
 * Mako removes only what it made: each placement is recorded as it lands, with what it was (a copy's file, a link's
 * target), and a removal deletes a path only while it's still that. A file the worktree already had, or one put in
 * place of Mako's since, is never touched. A removal is written down before it starts and crossed off once it's
 * done, so one cut short by a crash or a failed delete is taken up again.
 *
 * A placement lands under the broker's lock, only while its lease stands, and is recorded in the same hold. A revoke
 * takes that lock too, so it either stops the placement or finds it recorded and takes it away.
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

/**
 * One thing Mako made at a placement, by its path inside the entry ("" for the entry itself), its device and inode,
 * when it was made (`born`, where the file system says), and whether it's a folder. A placement's whole list is its
 * manifest: what a removal may take, and nothing else. The inode alone doesn't say it's the same file: Linux gives a
 * file written where another was deleted that one's inode, and a revoke took an agent's own `.env` for Mako's copy.
 * A manifest from before `born` matches by device and inode.
 */
type Owned = { path: string; dev: number; ino: number; born?: number; folder: boolean }

/** When `info`'s file was made, where its file system records it. */
const bornOf = (info: { birthtimeMs: number }): { born?: number } => (info.birthtimeMs > 0 ? { born: info.birthtimeMs } : {})

/** A placement: the lease, where it landed and what Mako made there; `removing` once its removal has begun. */
type Placed = { lease: string; checkout: string; root: string; entry: string; link: boolean; thread: string; generation: number; removing?: true; placing?: true }

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
    case "no-capable-device":
      return `${entry}: no device that can serve it had room`
    case "unavailable":
      return `${entry}: ${refusal.reason === "not-found" ? "it isn't in the main checkout" : refusal.reason === "outside" ? "it points outside the main checkout" : "the main checkout couldn't give it"}`
  }
}

/** Everything at `path` as Mako just made it, without following links: the entry itself first. */
async function survey(path: string): Promise<Owned[]> {
  const top = await lstat(path).catch(() => undefined)
  if (!top) return []
  const owned: Owned[] = [{ path: "", dev: top.dev, ino: top.ino, ...bornOf(top), folder: top.isDirectory() }]
  const walk = async (inner: string): Promise<void> => {
    for (const entry of await readdir(join(path, inner), { withFileTypes: true })) {
      const relative = inner ? `${inner}/${entry.name}` : entry.name
      const info = await lstat(join(path, relative))
      owned.push({ path: relative, dev: info.dev, ino: info.ino, ...bornOf(info), folder: info.isDirectory() })
      if (info.isDirectory()) await walk(relative)
    }
  }
  if (top.isDirectory()) await walk("")
  return owned
}

type Granted = { entry: string; link: boolean; lease: string; thread: string; root: string; checkout: string; generation: number }

function withoutPlacing(entry: Placed): Placed {
  const settled: Placed = { ...entry }
  delete settled.placing
  return settled
}

export interface CheckoutBorrowingOptions {
  borrowing: LocalBorrowing
  git: Git
  /** How a placement is deleted; a test fails it on purpose. */
  remove?: (path: string, recursive: boolean) => Promise<void>
  /** Runs after a carry or bring has placed its entries and before Mako finishes recording them; a test writes there as a person would. */
  afterPlacing?: (checkout: string) => Promise<void>
  /** Runs once a staged entry is about to land; a test revokes there. */
  beforeLanding?: (checkout: string) => Promise<void>
}

/** The sources a checkout broker answers for, to give any other broker over the same folder. */
export const CHECKOUT_SOURCES = { file: checkoutSource, tree: checkoutSource } satisfies Partial<Record<Kind, SourceFn>>

export class CheckoutBorrowing {
  readonly borrowing: LocalBorrowing
  readonly #git: Git
  readonly #remove: (path: string, recursive: boolean) => Promise<void>
  readonly #afterPlacing: ((checkout: string) => Promise<void>) | undefined
  readonly #beforeLanding: ((checkout: string) => Promise<void>) | undefined
  #memory: Placed[] = []
  readonly #manifests = new Map<string, Owned[]>()
  #seeded: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: CheckoutBorrowingOptions) {
    this.borrowing = options.borrowing
    this.#git = options.git
    this.#remove = options.remove ?? ((path, recursive) => rm(path, { recursive, force: true }))
    this.#afterPlacing = options.afterPlacing
    this.#beforeLanding = options.beforeLanding
    this.borrowing.onPush((borrower, push) => void this.#heard(borrower, push))
  }

  /** In memory, for a host or a test that keeps nothing: the same grants and decisions. */
  static inMemory(git: Git): CheckoutBorrowing {
    return CheckoutBorrowing.open(git)
  }

  /** This device's, keeping its grants, its log and what it placed in `folder`, with any other sources that folder's brokers serve. */
  static open(git: Git, folder?: string, more: Partial<Record<Kind, SourceFn>> = {}, remove?: CheckoutBorrowingOptions["remove"], afterPlacing?: CheckoutBorrowingOptions["afterPlacing"]): CheckoutBorrowing {
    const options: LocalBorrowingOptions = { device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, sources: { ...more, ...CHECKOUT_SOURCES } }
    if (folder) options.folder = folder
    const made: CheckoutBorrowingOptions = { git, borrowing: new LocalBorrowing(options) }
    if (remove) made.remove = remove
    if (afterPlacing) made.afterPlacing = afterPlacing
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
    const stopped = new Map<string, Refusal>()
    const placed = granted.length ? await carryFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link })), this.#told(granted, stopped)) : []
    await this.#afterPlacing?.(checkout)
    await this.#settle(granted, placed, stopped)
    refused.push(...[...stopped].map(([entry, refusal]) => refusalText(entry, refusal)))
    return { copied: placed.length, refused }
  }

  /** `worktree_bring`: the entries asked for, each under a lease, with what was refused and why. */
  async bring(thread: string, repoRoot: string, checkout: string, entries: readonly BringEntry[]): Promise<BringReport & { refused: string[] }> {
    const asked = entries.map((entry) => ({ path: entry.path, link: Boolean(entry.link) }))
    const { granted, refused, missing } = await this.#decide(thread, repoRoot, checkout, asked, "worktree_bring")
    const stopped = new Map<string, Refusal>()
    const report = granted.length ? await bringFiles(this.#git, repoRoot, checkout, granted.map(({ entry, link }) => ({ path: entry, link })), this.#told(granted, stopped)) : { copied: [], linked: [], owned: [], existing: [], missing: [] }
    // A linked entry made the worktree's own is Mako's copy now, in place of Mako's link.
    await this.#afterPlacing?.(checkout)
    await this.#settle(granted, [...report.copied, ...report.linked, ...report.owned], stopped)
    report.missing.push(...missing)
    report.existing = report.existing.filter((entry) => !stopped.has(entry))
    refused.push(...[...stopped].map(([entry, refusal]) => refusalText(entry, refusal)))
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
    const granted: Granted[] = []
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

  /**
   * What Mako is about to place for a granted entry, recorded as it sits in the staging folder, where nothing but
   * Mako writes: its placement is written down (as placing) and each thing in it added to the lease's manifest, and
   * it lands, all in one hold of the broker's lock and only while its lease stands. One whose lease has ended is
   * named in `stopped` and never lands. A file the person makes anywhere, at any moment, is never in a manifest.
   */
  #told(granted: ReadonlyArray<Granted>, stopped: Map<string, Refusal>): Staged {
    return async (relative, staged, land) => {
      const item = granted.find((entry) => relative === entry.entry || relative.startsWith(`${entry.entry}/`))
      if (!item) return land()
      const inner = relative === item.entry ? "" : relative.slice(item.entry.length + 1)
      const owned = (await survey(staged)).map((entry) => ({ ...entry, path: entry.path ? (inner ? `${inner}/${entry.path}` : entry.path) : inner }))
      await this.#beforeLanding?.(item.checkout)
      const landed = await this.borrowing.whileLeased(item.lease, async () => {
        await this.#editHeld(async (placed) => {
          await this.#writeManifest(item.lease, [...(await this.#readManifest(item.lease)), ...owned])
          const known = placed.some((held) => held.lease === item.lease)
          const entry: Placed = { lease: item.lease, checkout: item.checkout, root: item.root, entry: item.entry, link: item.link, thread: item.thread, generation: item.generation, placing: true }
          return { keep: known ? placed : [...placed, entry], value: undefined }
        })
        return land()
      })
      if ("done" in landed) return landed.done
      stopped.set(item.entry, { refused: landed.ended === "expired" ? "expired" : "revoked" })
      return false
    }
  }

  /**
   * After a placement: each entry that landed stops being `placing`, taking over what an earlier lease placed at the
   * same path (its manifest joins this one's); each that didn't land is let go, its record and lease with it. One
   * stopped by its lease's end may have landed in part, so its removal takes what it holds. One a revoke has already
   * taken away has nothing left to settle.
   */
  async #settle(granted: ReadonlyArray<Granted>, placedEntries: readonly string[], stopped: ReadonlyMap<string, Refusal>): Promise<void> {
    for (const item of granted) {
      if (stopped.has(item.entry)) {
        const held = (await this.#placed()).find((entry) => entry.lease === item.lease)
        if (held) await this.#unplace(held)
        continue
      }
      if (!placedEntries.includes(item.entry)) {
        const held = (await this.#placed()).find((entry) => entry.lease === item.lease)
        if (held?.placing) {
          await this.#dropManifest(item.lease)
          await this.#edit(async (placed) => ({ keep: placed.filter((entry) => entry.lease !== item.lease), value: undefined }))
        }
        if (!held || held.placing) await this.borrowing.release(item.lease)
        continue
      }
      const placed = await this.#placed()
      if (!placed.some((entry) => entry.lease === item.lease)) continue
      const earlier = placed.filter((entry) => entry.lease !== item.lease && entry.checkout === item.checkout && entry.entry === item.entry)
      for (const old of earlier) {
        await this.#writeManifest(item.lease, [...(await this.#readManifest(old.lease)), ...(await this.#readManifest(item.lease))])
        await this.#dropManifest(old.lease)
        await this.borrowing.release(old.lease)
      }
      await this.#edit(async (placed) => ({
        keep: placed.filter((entry) => !earlier.some((old) => old.lease === entry.lease)).map((entry) => (entry.lease === item.lease ? withoutPlacing(entry) : entry)),
        value: undefined,
      }))
    }
  }

  async #writeManifest(lease: string, manifest: Owned[]): Promise<void> {
    const folder = this.borrowing.folder
    if (!folder) {
      this.#manifests.set(lease, manifest)
      return
    }
    await mkdir(join(folder, "placed"), { recursive: true, mode: 0o700 })
    const temporary = join(folder, "placed", `.${lease}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(manifest), { mode: 0o600 })
    await rename(temporary, join(folder, "placed", `${lease}.json`))
  }

  async #readManifest(lease: string): Promise<Owned[]> {
    const folder = this.borrowing.folder
    if (!folder) return this.#manifests.get(lease) ?? []
    // SAFETY: only #writeManifest writes it, whole and by rename, from survey().
    return JSON.parse((await readFile(join(folder, "placed", `${lease}.json`), "utf8").catch(() => "")) || "[]") as Owned[]
  }

  async #dropManifest(lease: string): Promise<void> {
    this.#manifests.delete(lease)
    const folder = this.borrowing.folder
    if (folder) await rm(join(folder, "placed", `${lease}.json`), { force: true })
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
    // The placement and what it owns move to the new lease together. Another keep may have moved them first.
    const moved = await this.#edit(async (placed) => {
      if (!placed.some((held) => held.lease === item.lease)) return { keep: placed, value: false }
      await this.#writeManifest(lease, await this.#readManifest(item.lease))
      return { keep: placed.map((held) => (held.lease === item.lease ? { ...held, lease, generation: item.generation + 1 } : held)), value: true }
    })
    if (moved) await this.#dropManifest(item.lease)
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
   * What a lease placed, taken away entry by entry from its manifest: each file and link only while it's still the
   * one Mako made (same device, inode and birth), and each folder only once it's empty, so anything the person or an agent
   * added inside stays, with the folders holding it. The removal is written down first and crossed off after, so a
   * delete that fails or is cut short is done by the next `keep`.
   */
  async #unplace(item: Placed): Promise<void> {
    await this.#edit((placed) => ({ keep: placed.map((held) => (held.lease === item.lease ? { ...held, removing: true as const } : held)), value: undefined }))
    const base = join(item.checkout, item.entry)
    const manifest = [...(await this.#readManifest(item.lease))].sort((left, right) => right.path.split("/").length - left.path.split("/").length || right.path.length - left.path.length)
    let failed: unknown
    for (const owned of manifest) {
      const path = owned.path ? join(base, owned.path) : base
      try {
        const info = await lstat(path)
        if (info.dev !== owned.dev || info.ino !== owned.ino || (owned.born !== undefined && bornOf(info).born !== owned.born)) continue
        if (owned.folder) await rmdir(path)
        else await this.#remove(path, false)
      } catch (error) {
        // Gone already, or a folder that holds what the person added: done. Anything else, the removal stays written down.
        const why = error instanceof Error && "code" in error ? error.code : undefined
        if (why === "ENOENT" || (owned.folder && (why === "ENOTEMPTY" || why === "EEXIST"))) continue
        failed ??= error
      }
    }
    if (failed) throw failed
    await this.#dropManifest(item.lease)
    await this.#edit((placed) => ({ keep: placed.filter((held) => held.lease !== item.lease), value: undefined }))
  }

  async #placed(): Promise<Placed[]> {
    return this.#edit((placed) => ({ keep: placed, value: placed }))
  }

  /** The index of placements, read, changed and written back under the broker's lock. */
  #edit<T>(change: (placed: Placed[]) => { keep: Placed[]; value: T } | Promise<{ keep: Placed[]; value: T }>): Promise<T> {
    return this.borrowing.locked(() => this.#editHeld(change))
  }

  /** `#edit`, for a caller already holding the broker's lock. */
  async #editHeld<T>(change: (placed: Placed[]) => { keep: Placed[]; value: T } | Promise<{ keep: Placed[]; value: T }>): Promise<T> {
    const folder = this.borrowing.folder
    // SAFETY: only this method writes the file, whole and by rename, under the folder's lock.
    const placed = folder ? (JSON.parse((await readFile(join(folder, "placed.json"), "utf8").catch(() => "")) || "[]") as Placed[]) : this.#memory
    const { keep, value } = await change(placed)
    if (!folder) this.#memory = keep
    else {
      const temporary = join(folder, `.placed.${process.pid}.${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(keep), { mode: 0o600 })
      await rename(temporary, join(folder, "placed.json"))
    }
    return value
  }
}
