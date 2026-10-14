import { ClaudeProvider } from "./providers/claude.js"
import { CodexProvider } from "./providers/codex.js"
import { CursorProvider } from "./providers/cursor.js"
import { DevinCliProvider } from "./providers/devin-cli.js"
import { DevinLocalProvider } from "./providers/devin-local.js"
import { GrokProvider } from "./providers/grok.js"
import { OpenCodeProvider } from "./providers/opencode.js"
import type { SessionProvider } from "./providers/types.js"
import type { NativeStores } from "./read-only-sqlite.js"

/**
 * Makes one store's reader over its host's `stores`; a catalog makes its own,
 * since a reader holds what it has read.
 */
export type SavedHistoryReader = (stores: NativeStores) => SessionProvider

/**
 * The saved-history readers Mako ships, one per store a harness keeps. The
 * catalog, its sharing identity and `readableHarnesses` all start from this
 * list, so the detached daemon reads the same stores the app does without
 * asking Electron. A harness's reader goes here, as its vocabulary goes in
 * `VOCABULARIES`; one outside this package is passed to the catalog with
 * these (`defaultCatalog({ readers })`).
 */
export const SAVED_HISTORY_READERS: readonly SavedHistoryReader[] = [
  (stores) => new CodexProvider(stores),
  (stores) => new ClaudeProvider(undefined, stores),
  (stores) => new CursorProvider(stores),
  () => new GrokProvider(),
  (stores) => new OpenCodeProvider(stores),
  (stores) => new DevinLocalProvider(stores),
  (stores) => new DevinCliProvider(stores),
]
