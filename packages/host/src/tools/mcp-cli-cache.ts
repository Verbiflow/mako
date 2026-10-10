import { stat } from "node:fs/promises"

/**
 * Reuses a harness CLI's MCP listing while nothing it reads has changed.
 *
 * A listing is keyed by who asked (harness, account, folder) and stamped with the
 * stat of every file it depends on, the CLI's own executable included. A changed
 * stamp runs the CLI again before answering, so a listing is never served past a
 * change Mako can see. Concurrent asks for the same stamp share one run. A failed
 * run is not kept. A kept listing older than `refreshAfterMs` is still served, and
 * the CLI runs again in the background, which bounds how long a change to a file
 * nobody declared can go unseen.
 */
export interface CliListingCache<T> {
  read(key: string, inputs: readonly string[], list: () => Promise<T>): Promise<T>
  clear(): void
}

export interface CliListingCacheOptions {
  refreshAfterMs: number
  /** Listings kept at once; the least recently read goes first. */
  limit: number
  now?: () => number
}

interface Entry<T> {
  stamp: string
  listing: Promise<T>
  /** When the run behind `listing` started; a run in flight counts as fresh. */
  listedAt: number
  refreshing: boolean
}

export function cliListingCache<T>({
  refreshAfterMs,
  limit,
  now = Date.now,
}: CliListingCacheOptions): CliListingCache<T> {
  const entries = new Map<string, Entry<T>>()

  function keep(key: string, entry: Entry<T>) {
    entries.delete(key)
    entries.set(key, entry)
    for (const oldest of entries.keys()) {
      if (entries.size <= limit) break
      entries.delete(oldest)
    }
  }

  function run(key: string, stamp: string, list: () => Promise<T>): Entry<T> {
    const entry: Entry<T> = { stamp, listing: list(), listedAt: now(), refreshing: false }
    entry.listing.catch(() => {
      if (entries.get(key) === entry) entries.delete(key)
    })
    keep(key, entry)
    return entry
  }

  function refresh(key: string, entry: Entry<T>, list: () => Promise<T>) {
    entry.refreshing = true
    const startedAt = now()
    list().then(
      (listing) => {
        if (entries.get(key) !== entry) return
        keep(key, { stamp: entry.stamp, listing: Promise.resolve(listing), listedAt: startedAt, refreshing: false })
      },
      () => {
        entry.refreshing = false
      }
    )
  }

  return {
    async read(key, inputs, list) {
      const stamp = await stampOf(inputs)
      const entry = entries.get(key)
      if (!entry || entry.stamp !== stamp) return run(key, stamp, list).listing
      keep(key, entry)
      if (!entry.refreshing && now() - entry.listedAt >= refreshAfterMs) {
        refresh(key, entry, list)
      }
      return entry.listing
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
