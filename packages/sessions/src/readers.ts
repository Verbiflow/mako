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

/** Where Devin.app keeps its user data under a home, as `DevinLocalProvider` defaults to. */
export const DEVIN_APP_USER = join("Library", "Application Support", "Devin", "User")

/**
 * A home other than the machine's for a reader to read under, as a session
 * restored from the record store into a folder of Mako's own is. `kept` is
 * the machine's kept outputs (`keptOutputsPath`), which aren't the session's
 * records and stay where they are.
 */
export interface ReaderPlace {
  home: string
  kept: string
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
  (stores, place) => place ? new CursorProvider(stores, place.home, {}, place.kept) : new CursorProvider(stores),
  (_stores, place) => new GrokProvider(place?.home),
  (stores, place) => new OpenCodeProvider(stores, place?.home),
  (stores, place) => new DevinLocalProvider(stores, place && join(place.home, DEVIN_APP_USER)),
  (stores, place) => new DevinCliProvider(stores, place?.home),
]
