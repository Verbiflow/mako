import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { downloadElectron } from "./lib/ci-electron.mjs"

const require = createRequire(import.meta.url)
await downloadElectron({
  artifactName: "electron",
  version: require("electron/package.json").version,
  checksums: require("electron/checksums.json"),
  cacheRoot: process.env.electron_config_cache,
})
// The installer reads the verified archive from the same cache; package installation and tests aren't retried.
const env = { ...process.env }
delete env.ELECTRON_SKIP_BINARY_DOWNLOAD
const child = spawnSync(process.execPath, [require.resolve("electron/install.js")], { stdio: "inherit", env })
if (child.error) throw child.error
process.exitCode = child.status ?? 1
