import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { CloudSignIn } from "@mako/host/contracts/cloud-sign-ins"
import { CloudSignInSync } from "@mako/host/harnesses/cloud-sign-ins"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"

/**
 * This computer's harness sign-ins exactly as the host shares them with Mako Cloud: `CloudSignInSync` itself,
 * renewing one about to lapse through its harness, with a store that collects what it would send. Written to
 * stdout as JSON for a run to give a test account, piped, never to a file; no refresh token is in it. Each
 * harness's outcome goes to stderr as its name, who it's signed in as and when it lapses.
 *
 *   npx tsx scripts/export-cloud-sign-ins.ts | (cd ../mako-backend && npm run machines -- agent-e2e … --sign-ins -)
 */
if (process.stdout.isTTY) {
  console.error("This writes sign-ins to stdout: pipe it into the run that takes them, never to a terminal.")
  process.exit(2)
}
const dataRoot = await mkdtemp(join(tmpdir(), "mako-export-sign-ins-"))
try {
  const host = createHarnessHost(detachedHarnessContext(new NativeStores(false), dataRoot))
  const collected: CloudSignIn[] = []
  const sync = new CloudSignInSync({
    accounts: host.accounts,
    capabilities: host.accountCapabilities,
    store: {
      blocked: async () => undefined,
      list: async () => [],
      put: async (signIn) => void collected.push(signIn),
      remove: async () => {},
    },
    dataRoot,
    onChange: () => {},
  })
  const state = await sync.share(true)
  sync.stop()
  for (const row of state.harnesses)
    console.error(`${row.harness}: ${row.status}${row.label ? ` as ${row.label}` : ""}${row.expiresAt ? `, lapses ${row.expiresAt}` : ""}${row.problem ? ` (${row.problem})` : ""}`)
  process.stdout.write(`${JSON.stringify(collected)}\n`)
} finally {
  await rm(dataRoot, { recursive: true, force: true })
}
