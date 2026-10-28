import { tmpdir } from "node:os"
import { join } from "node:path"
import { makoUserRoot } from "@mako/sessions/mako-root"

/**
 * The folders Mako's own tests and proofs run harnesses in, which hold no person's work:
 *
 * - `fixture`: a disposable folder a test or probe makes under the OS temporary folder, named `mako-…` (every test's
 *   `mkdtemp` prefix starts so) or one of the older probes' prefixes below;
 * - `moves-e2e`: a run of the cloud moves proof (`machines -- moves-e2e`), `<user root>/moves-e2e/run-…`, under the
 *   home because a cloud machine can make the same folder there;
 * - `thread-data`: a Thread's data folder (`<user root>/thread-data/…`), where its agents keep scratch copies of a
 *   checkout, builds and proofs' roots.
 *
 * Proofs run their harnesses in scratch homes (`scratch-harness-home.ts`), so a session in one of these is one an
 * earlier run left in the person's stores. macOS keeps temporary folders around, so a folder's presence says nothing.
 */
export type ProofFolder = "fixture" | "moves-e2e" | "thread-data"

const FIXTURE_DIRECTORY = /\/(?:mako|acp-perm|acp-steer|acp-steer-tools|acp-probe|codex-home|codex-steer)-[^/]+(?:\/|$)/
const TEMPORARY = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]

/** Which proof folder a session's working folder is in, if any. */
export function proofFolder(cwd: string | undefined, userRoot = makoUserRoot()): ProofFolder | undefined {
  if (!cwd) return undefined
  if (cwd.startsWith(`${join(userRoot, "moves-e2e")}/run-`)) return "moves-e2e"
  if (cwd.startsWith(`${join(userRoot, "thread-data")}/`)) return "thread-data"
  if (TEMPORARY.some((root) => cwd.startsWith(root)) && FIXTURE_DIRECTORY.test(cwd)) return "fixture"
  return undefined
}
