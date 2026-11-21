// A sessions daemon serving an empty catalog on a family of pipes (`@mako/sessions/private-pipe`), for
// scripts/test-windows-pipes.ts: it serves, says `serving`, and runs until it's ended.
//
//   node scripts/windows-host/serve-fake-catalog.mjs <family>
import { serveCatalog } from "@mako/sessions"

const catalog = {
  count: 0,
  list: () => [],
  open: async () => undefined,
  page: async () => undefined,
  entry: async () => undefined,
  follow: () => () => undefined,
  onEvent: () => () => undefined,
  stop: () => undefined,
  scopeSync: () => undefined,
  syncStatus: async () => ({ paused: false, tiers: {}, stale: 0, copies: null, originals: null }),
}
await serveCatalog(catalog, process.argv[2])
console.log("serving")
setInterval(() => undefined, 60_000)
