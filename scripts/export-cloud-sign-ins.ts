import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { childProcessEnv } from "@mako/host/base/child-environment"
import { CloudSignInHarnessSchema, CloudSignInSchema, type CloudSignIn } from "@mako/host/contracts/cloud-sign-ins"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"

/**
 * This computer's harness sign-ins as a machine is given them: each adapter's own `export`, the refresh token
 * withheld, read from the store each harness runs under here. Written to stdout as JSON for a run to give a test
 * account, piped, never to a file. Each harness's outcome goes to stderr as its name, who it's signed in as and
 * when it lapses.
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
  for (const capability of host.accountCapabilities.list()) {
    const harness = CloudSignInHarnessSchema.safeParse(capability.provider)
    if (!harness.success || !capability.cloudSignIn) continue
    try {
      const launch = await host.accounts.launch(harness.data, childProcessEnv(process.env), { trackCredential: false })
      const exported = await capability.cloudSignIn.export(launch.env)
      if (!exported) {
        console.error(`${harness.data}: signed out`)
        continue
      }
      const signIn = CloudSignInSchema.parse({ harness: harness.data, ...exported, label: exported.label ?? (await host.accounts.principal(harness.data, launch.account.name)) ?? null })
      collected.push(signIn)
      console.error(`${harness.data}: exported${signIn.label ? ` as ${signIn.label}` : ""}${signIn.expiresAt ? `, lapses ${signIn.expiresAt}` : ""}`)
    } catch (error) {
      console.error(`${harness.data}: failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  process.stdout.write(`${JSON.stringify(collected)}\n`)
} finally {
  await rm(dataRoot, { recursive: true, force: true })
}
