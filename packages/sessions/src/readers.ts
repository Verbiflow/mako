import { join } from "node:path"
import { ClaudeProvider } from "./providers/claude.js"
import { CodexProvider } from "./providers/codex.js"
import { CursorProvider } from "./providers/cursor.js"
import { DevinCliProvider } from "./providers/devin-cli.js"
import { DevinLocalProvider } from "./providers/devin-local.js"
import { GrokProvider } from "./providers/grok.js"
import { OpenCodeProvider } from "./providers/opencode.js"
import type { SessionProvider } from "./providers/types.js"
import type { NativeStores } from "./read-only-sqlite.js"
import { keptOutputsIn } from "./kept-outputs.js"
import { makoUserRoot } from "./mako-root.js"

/** Where Devin.app keeps its user data under a home, as `DevinLocalProvider` defaults to. */
export const DEVIN_APP_USER = join("Library", "Application Support", "Devin", "User")

/**
 * Where a reader reads: the home a harness keeps its own stores under, and
 * Mako's per-user folder (`HostEnvironment.userRoot`), which holds the
 * stores Mako places for a harness (Cursor's SDK agents, `cursorSdkStateRoot`).
 * A host hands its own, so an isolated host reads its root's and not the
 * person's; a session restored from the record store reads in a home of
 * Mako's own, with that home's `.mako`. `kept` is the host's kept outputs
 * (`keptOutputsIn`), which aren't a session's records and stay where they are.
 */
export interface ReaderPlace {
  home: string
  userRoot: string
  kept: string
}

/** A place wholly under one home: its `.mako` is the user root, as the person's Mako keeps it. */
export function homePlace(home: string): ReaderPlace {
  const userRoot = makoUserRoot(home)
  return { home, userRoot, kept: keptOutputsIn(userRoot) }
}

/**
 * Makes one store's reader over its host's `stores`; a catalog makes its own,
 * since a reader holds what it has read. Without `place` it reads the
 * machine's own stores, as its environment names them.
 */
export type SavedHistoryReader = (stores: NativeStores, place?: ReaderPlace) => SessionProvider

/**
 * The saved-history readers Mako ships, one per store a harness keeps. The
 * catalog, its sharing identity and `readableHarnesses` all start from this
 * list, so the detached daemon reads the same stores the app does without
 * asking Electron. A harness's reader goes here, as its vocabulary goes in
 * `VOCABULARIES`; one outside this package is passed to the catalog with
 * these (`defaultCatalog({ readers })`).
 */
export const SAVED_HISTORY_READERS: readonly SavedHistoryReader[] = [
  (stores, place) => new CodexProvider(stores, place?.home),
  (stores, place) => place ? new ClaudeProvider(place.home, stores, place.kept) : new ClaudeProvider(undefined, stores),
  (stores, place) => place ? new CursorProvider(stores, place.home, place.userRoot, place.kept) : new CursorProvider(stores),
  (_stores, place) => new GrokProvider(place?.home),
  (stores, place) => new OpenCodeProvider(stores, place?.home),
  (stores, place) => new DevinLocalProvider(stores, place && join(place.home, DEVIN_APP_USER)),
  (stores, place) => new DevinCliProvider(stores, place?.home),
]
