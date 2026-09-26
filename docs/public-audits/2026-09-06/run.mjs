import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const checks = [
  "storage-repro.mjs",
  "cursor-wal-repro.mjs",
  "codex-envelope-repro.mjs",
  "content-repro.mjs",
  "streaming-repro.mjs",
  "live-state-repro.mjs",
  "convergence-route-repro.mjs",
]

console.log("Mako known-defect diagnostics. Assertions confirm defects; they are not acceptance tests.")
for (const check of checks) {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL(check, import.meta.url)),
  ], { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log("All known-defect diagnostics reproduced. No live provider calls or private sessions used.")
