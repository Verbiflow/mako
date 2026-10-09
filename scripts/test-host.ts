import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { headlessNodeExecutable } from "../electron/headless-node.ts"

/**
 * The host's tests, under each runtime the host runs in: this Node, as on a
 * cloud machine, and Electron's Helper in Node mode, which is how
 * `hostCommand` starts it on a Mac. `--runtime node` or `--runtime electron`
 * runs one.
 */
const TESTS = [
  "scripts/test-host-environment.ts",
  "scripts/test-host-node.ts",
  "scripts/test-client-calls.ts",
  "scripts/test-machine.ts",
  "scripts/test-host-lock.ts",
  "scripts/test-host-lifecycle.ts",
  "scripts/test-secrets.ts",
  "scripts/test-host-secrets.ts",
  "scripts/test-secret-key-handover.ts",
  "scripts/test-keychain-safe-storage.ts",
  "scripts/test-desktop-channel.ts",
  "scripts/test-host-domains.ts",
  "scripts/test-cloud-account.ts",
  "scripts/test-telemetry.ts",
  "scripts/test-workspace-clients.ts",
  "scripts/test-file-open.ts",
  "scripts/test-git-staging.ts",
  "scripts/test-git-preview.ts",
  "scripts/test-git-push.ts",
]

/** The npm package's main export is the path to Electron's executable. */
const electronPath: string = createRequire(import.meta.url)("electron")
const RUNTIMES = ["node", "electron"] as const
type Runtime = (typeof RUNTIMES)[number]
const isRuntime = (name: string | undefined): name is Runtime => RUNTIMES.some((runtime) => runtime === name)
const launch = {
  node: { executable: process.execPath, env: {} },
  electron: { executable: headlessNodeExecutable(electronPath), env: { ELECTRON_RUN_AS_NODE: "1" } },
} satisfies Record<Runtime, { executable: string; env: NodeJS.ProcessEnv }>
const asked = process.argv.includes("--runtime") ? process.argv[process.argv.indexOf("--runtime") + 1] : undefined
if (asked !== undefined && !isRuntime(asked)) throw new Error(`--runtime is node or electron, not ${asked}`)
const chosen: readonly Runtime[] = isRuntime(asked) ? [asked] : RUNTIMES

for (const name of chosen) {
  const runtime = launch[name]
  const started = performance.now()
  console.log(`\n== host tests under ${name === "node" ? `Node ${process.versions.node}` : "Electron's Helper in Node mode"}`)
  for (const test of TESTS) {
    const run = spawnSync(runtime.executable, ["--import", "tsx", test], {
      stdio: "inherit",
      env: { ...process.env, ...runtime.env },
    })
    if (run.status !== 0) {
      console.error(`${test} failed under ${name} (${run.signal ?? `exit ${run.status}`})`)
      process.exit(1)
    }
  }
  console.log(`== ${TESTS.length} host tests passed under ${name} in ${Math.round((performance.now() - started) / 1000)}s`)
}
