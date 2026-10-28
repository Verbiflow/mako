import { homedir } from "node:os"
import { resolve } from "node:path"
import { z } from "zod"
import { userRootFor } from "@mako/host/base/host-environment"
import type { RuntimeValue } from "@mako/host/contracts/runtime"
import { appDataFolder } from "@mako/host/transport/service"
import { harnessStoreRoots } from "@mako/sessions"

/**
 * A proof drives a host of its own, never this Mac's own Mako nor one of its profiles: their Threads, sessions and
 * worktrees are the person's, and a proof's would join their sidebar. Its data root must sit outside the
 * application-data folder (an isolated host's, `HostEnvironment.isolated`), such as a `PackagedApp`'s profile or a root
 * `prove-cloud-moves --spawn-host` starts a host on.
 */
export function proofDataRoot(dataRoot: string | undefined, what: string): string {
  if (!dataRoot) throw new Error(`${what} runs only on a host of its own: name its data root with --data-root, never this Mac's own Mako`)
  if (userRootFor({ dataRoot, appData: appDataFolder(), home: homedir() }) !== resolve(dataRoot))
    throw new Error(`${what}: refused, ${dataRoot} is a profile of this Mac's own Mako, whose Threads and sessions are the person's; use a host of its own (a PackagedApp's profile)`)
  return dataRoot
}

const Listed = z.object({ ready: z.boolean(), threads: z.array(z.object({ path: z.string() }).loose()) }).loose()

/**
 * The host runs its harnesses in a home of its own (`scratchHostHome`): its catalog lists no session from the person's
 * harness stores, the folders their own Mako reads. A host in their home would write a proof's sessions there, into
 * their sidebar. Waits for the host's first full catalog.
 */
export async function assertOwnHarnessStores(call: (channel: string, args: unknown[]) => Promise<RuntimeValue>, dataRoot: string): Promise<void> {
  const theirs = harnessStoreRoots().flatMap(({ roots }) => roots)
  for (const deadline = Date.now() + 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const listed = Listed.parse(await call("mako:threads", []))
    const shared = listed.threads.find(({ path }) => theirs.some((root) => path === root || path.startsWith(`${root}/`)))
    if (shared) throw new Error(`the host at ${dataRoot} lists ${shared.path}: it runs in the person's own home, where its harnesses would write a proof's sessions into their stores. Start it in a scratch home (scratchHostHome, as PackagedApp does)`)
    if (listed.ready) return
    if (Date.now() > deadline) throw new Error(`the host at ${dataRoot} hasn't read its catalog within a minute`)
  }
}
