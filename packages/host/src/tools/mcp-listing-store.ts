import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { JsonObjectSchema, JsonValueSchema, jsonStoreAccess, unknownFields, type JsonObject } from "@mako/sessions/store-format"
import { publishFile } from "../base/published-files.js"
import type { CliListingStore, KeptListing } from "./mcp-cli-cache.js"

/** The file's format: a build that knows a later one reads and rewrites this one too (`jsonStoreAccess`). */
const FORMAT = 1
/** Listings kept in the file, the most recently read first to stay. */
const KEPT = 64
/** A listing longer than this is read again by each host rather than kept: the file is rewritten whole on every save. */
const LISTING_BYTES = 256 * 1024
const ENTRY_FIELDS = ["stamp", "listing", "listedAt"] as const
const EntrySchema = z.object({ stamp: z.string(), listing: z.string(), listedAt: z.number() })
const FileSchema = z.object({ listings: JsonObjectSchema })

/** Where a user root (`HostEnvironment.userRoot`) keeps its harnesses' MCP listings, one file for every host on it. */
export function mcpListingsPath(userRoot: string): string {
  return join(userRoot, "mcp-listings.json")
}

/** The file as it is: its listings as written, and the fields beside them this build doesn't name. */
async function rawFile(path: string): Promise<{ listings: JsonObject; rest: JsonObject; access: ReturnType<typeof jsonStoreAccess> }> {
  const empty = { listings: {}, rest: {}, access: "write" as const }
  let parsed: z.infer<typeof JsonValueSchema>
  try {
    parsed = JsonValueSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch {
    // No file yet, or a torn one: the listings are read again and kept from there.
    return empty
  }
  const access = jsonStoreAccess(parsed, FORMAT)
  const file = FileSchema.safeParse(parsed)
  if (!file.success) return { ...empty, access }
  return { listings: file.data.listings, rest: unknownFields(parsed, ["version", "listings"]), access }
}

/**
 * A harness CLI's MCP listings kept in one JSON file of the user root, which the installed app and every other build
 * on that root share: it keeps `version`, a build that can't write the format leaves the file alone and keeps its
 * listings in memory, and a rewrite carries back the listings and fields it doesn't name. A listing can hold what
 * the harness's own config holds (a server's environment), so the file is the person's alone to read, as that is.
 */
export function mcpListingStore(path: string): CliListingStore<string> {
  return {
    async load() {
      const kept = new Map<string, KeptListing<string>>()
      const raw = await rawFile(path)
      if (raw.access === "refused") return kept
      for (const [key, value] of Object.entries(raw.listings)) {
        const entry = EntrySchema.safeParse(value)
        if (entry.success) kept.set(key, entry.data)
      }
      return kept
    },
    async save(kept) {
      const raw = await rawFile(path)
      // A newer Mako's format is its to rewrite.
      if (raw.access !== "write") return
      const listings = new Map<string, KeptListing<string>>()
      const unread: JsonObject = {}
      // Another host on this root saved since this one loaded: its listings stay, the newer of two for one key.
      for (const [key, value] of Object.entries(raw.listings)) {
        const entry = EntrySchema.safeParse(value)
        if (entry.success) listings.set(key, entry.data)
        else unread[key] = value
      }
      for (const [key, entry] of kept) {
        const other = listings.get(key)
        if (entry.listing.length <= LISTING_BYTES && (!other || other.listedAt <= entry.listedAt)) listings.set(key, entry)
      }
      const newest = [...listings].sort(([, left], [, right]) => right.listedAt - left.listedAt).slice(0, KEPT)
      const written: JsonObject = { ...unread }
      for (const [key, entry] of newest)
        written[key] = { ...unknownFields(raw.listings[key], ENTRY_FIELDS), stamp: entry.stamp, listing: entry.listing, listedAt: entry.listedAt }
      await publishFile(path, JSON.stringify({ ...raw.rest, version: FORMAT, listings: written }), { mode: 0o600, dirMode: 0o700 })
    },
  }
}
