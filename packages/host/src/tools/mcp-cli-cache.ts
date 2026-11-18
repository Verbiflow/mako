import { readFile, stat } from "node:fs/promises"

/**
 * Reuses a harness CLI's MCP listing while nothing it reads has changed.
 *
 * A listing is keyed by who asked (harness, account, folder) and stamped with the
 * stat of every file it depends on, the CLI's own executable included. A changed
 * stamp runs the CLI again before answering, so a listing is never served past a
 * change Mako can see. Concurrent asks for the same stamp share one run. A failed
 * run is not kept. A kept listing older than `refreshAfterMs` is still served, and
 * the CLI runs again in the background, which bounds how long a change to a file
 * nobody declared can go unseen; that run waits for `idle` first, so it never
 * competes with a harness's start.
 *
 * With a `store` the listings outlive the host: each is saved with its stamp as it
 * is read and loaded before the first answer, so the first start after a restart
 * compares the stamp it finds on disk exactly as it would one in memory. Every
 * start after every restart ran both CLIs otherwise, seconds each on a busy Mac.
 */
export interface CliListingCache<T> {
  read(key: string, inputs: readonly string[], list: () => Promise<T>): Promise<T>
  /**
   * What is kept, without waiting for the CLI where anything is: the listing under `key` even when an input has
   * changed since, read again behind the answer once `idle`. For a harness other than the one starting, whose
   * servers a start must have but shouldn't wait for.
   *
   * With nothing kept under `key` (a folder never listed: every Thread's new worktree), the newest listing kept under
   * a key `sibling` accepts (the same harness and account in another checkout of the same repository) answers, and
   * `key`'s own is read behind it. Only one that would read the same: the sibling's inputs are as they were when it
   * was listed, and the inputs the two don't share (each checkout's own project config) hold the same text. With none
   * such, the CLI is waited for, as `read` waits.
   */
  peek(key: string, inputs: readonly string[], list: () => Promise<T>, sibling?: (other: string) => boolean): Promise<T>
  clear(): void
}

/** A listing as it is kept between hosts: what it read as (`stamp`), and when its run started. */
export interface KeptListing<T> {
  stamp: string
  listing: T
  listedAt: number
}

/** Where listings are kept between hosts. A load or a save that fails leaves the cache as it is in memory. */
export interface CliListingStore<T> {
  load(): Promise<ReadonlyMap<string, KeptListing<T>>>
  save(kept: ReadonlyMap<string, KeptListing<T>>): Promise<void>
}

export interface CliListingCacheOptions<T = string> {
  refreshAfterMs: number
  /** Listings kept at once; the least recently read goes first. */
  limit: number
  now?: () => number
  /** Resolves when nothing a person waits on is running: a background run waits for it. */
  idle?: () => Promise<void>
  store?: CliListingStore<T>
}

interface Entry<T> {
  stamp: string
  listing: Promise<T>
  /** The listing once its run has answered: what `peek` gives and what is saved. */
  settled?: { listing: T }
  /** When the run behind `listing` started; a run in flight counts as fresh. */
  listedAt: number
  refreshing: boolean
}

export function cliListingCache<T>({
  refreshAfterMs,
  limit,
  now = Date.now,
  idle = () => Promise.resolve(),
  store,
}: CliListingCacheOptions<T>): CliListingCache<T> {
  const entries = new Map<string, Entry<T>>()
  /** Keys with no listing kept whose first run waits behind a start (`peek`). */
  const behind = new Set<string>()
  let saving: Promise<void> = Promise.resolve()
  let saveQueued = false

  // Loaded at once, so the first start finds what the last host kept; every read waits for it.
  const loaded: Promise<void> = store
    ? store.load().then((kept) => {
        // Oldest first, so the newest are the last to go past the limit.
        for (const [key, { stamp, listing, listedAt }] of [...kept].sort(([, left], [, right]) => left.listedAt - right.listedAt))
          keep(key, { stamp, listing: Promise.resolve(listing), settled: { listing }, listedAt, refreshing: false })
      }, () => undefined)
    : Promise.resolve()

  function trim() {
    for (const oldest of entries.keys()) {
      if (entries.size <= limit) break
      entries.delete(oldest)
    }
  }

  function keep(key: string, entry: Entry<T>) {
    entries.delete(key)
    entries.set(key, entry)
    trim()
  }

  /** One save at a time, and one more after it for whatever settled meanwhile. */
  function save() {
    if (!store || saveQueued) return
    saveQueued = true
    saving = saving.then(() => {
      saveQueued = false
      const kept = new Map<string, KeptListing<T>>()
      for (const [key, entry] of entries)
        if (entry.settled) kept.set(key, { stamp: entry.stamp, listing: entry.settled.listing, listedAt: entry.listedAt })
      return store.save(kept).catch(() => undefined)
    })
  }

  function run(key: string, stamp: string, list: () => Promise<T>): Entry<T> {
    const entry: Entry<T> = { stamp, listing: list(), listedAt: now(), refreshing: false }
    entry.listing.then(
      (listing) => {
        entry.settled = { listing }
        if (entries.get(key) === entry) save()
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key)
      }
    )
    keep(key, entry)
    return entry
  }

  function refresh(key: string, entry: Entry<T>, list: () => Promise<T>, stamp = entry.stamp) {
    entry.refreshing = true
    void idle().then(() => rerun(key, entry, list, stamp))
  }

  function rerun(key: string, entry: Entry<T>, list: () => Promise<T>, stamp: string) {
    // A change read while it waited listed again already.
    if (entries.get(key) !== entry) return
    const startedAt = now()
    list().then(
      (listing) => {
        if (entries.get(key) !== entry) return
        keep(key, { stamp, listing: Promise.resolve(listing), settled: { listing }, listedAt: startedAt, refreshing: false })
        save()
      },
      () => {
        entry.refreshing = false
      }
    )
  }

  /** The newest listing kept for another folder that `key`'s own run would repeat (`peek`). */
  async function siblingListing(key: string, inputs: readonly string[], sibling: (other: string) => boolean): Promise<{ listing: T } | undefined> {
    const kept = [...entries].filter(([other, entry]) => other !== key && entry.settled && sibling(other)).sort(([, left], [, right]) => right.listedAt - left.listedAt)
    for (const [, entry] of kept) {
      const theirs = stampedFiles(entry.stamp)
      // Changed since it was listed: its own next ask reads it again, and it answers for nobody meanwhile.
      if (await stampOf(theirs) !== entry.stamp) continue
      const [mine, other] = await Promise.all([textsOf(inputs.filter((file) => !theirs.includes(file))), textsOf(theirs.filter((file) => !inputs.includes(file)))])
      if (mine.length === other.length && mine.every((text, index) => text === other[index]) && entry.settled) return entry.settled
    }
    return undefined
  }

  return {
    async read(key, inputs, list) {
      await loaded
      const stamp = await stampOf(inputs)
      const entry = entries.get(key)
      if (!entry || entry.stamp !== stamp) return run(key, stamp, list).listing
      keep(key, entry)
      if (!entry.refreshing && now() - entry.listedAt >= refreshAfterMs) {
        refresh(key, entry, list)
      }
      return entry.listing
    },
    async peek(key, inputs, list, sibling) {
      await loaded
      const stamp = await stampOf(inputs)
      const entry = entries.get(key)
      if (entry) {
        keep(key, entry)
        if (!entry.refreshing && (entry.stamp !== stamp || now() - entry.listedAt >= refreshAfterMs)) refresh(key, entry, list, stamp)
        // Its first run still under way: nothing older to give, so it is waited for.
        return entry.settled?.listing ?? entry.listing
      }
      const borrowed = sibling && await siblingListing(key, inputs, sibling)
      // Listed while the siblings were compared: that one stands.
      const listed = entries.get(key)
      if (listed) return listed.listing
      if (!borrowed) return run(key, stamp, list).listing
      if (!behind.has(key)) {
        behind.add(key)
        void idle().then(() => {
          behind.delete(key)
          // A start of its own harness read it meanwhile.
          if (!entries.has(key)) run(key, stamp, list).listing.catch(() => undefined)
        })
      }
      return borrowed.listing
    },
    clear() {
      entries.clear()
    },
  }
}

/** Each file's identity, size and change times; a missing or unreadable file is part of the stamp too, so creating it is a change. */
export async function stampOf(files: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    files.map((file) =>
      stat(file, { bigint: true }).then(
        (found) => `${file}\0${found.dev}:${found.ino}:${found.size}:${found.mtimeNs}:${found.ctimeNs}`,
        (error: NodeJS.ErrnoException) => `${file}\0${error.code ?? "unreadable"}`
      )
    )
  )
  return parts.join("\n")
}

/** The files a stamp was taken of (`stampOf`). */
function stampedFiles(stamp: string): string[] {
  return stamp.split("\n").map((part) => part.slice(0, Math.max(0, part.indexOf("\0")))).filter(Boolean)
}

/** What each of `files` that can be read holds, in an order that doesn't depend on where they are. */
async function textsOf(files: readonly string[]): Promise<string[]> {
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => undefined)))
  return texts.flatMap((text) => (text === undefined ? [] : [text])).sort()
}
