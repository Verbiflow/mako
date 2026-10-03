import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { registeredHarnessIds } from "./registered-harnesses.ts"
const outfile = "node_modules/.tmp/test-shared-thread-ui.mjs"
await build({
  entryPoints: ["scripts/test-shared-thread-ui.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  jsx: "automatic",
  tsconfig: "tsconfig.app.json",
  outfile,
})
execFileSync(process.execPath, [outfile, ...registeredHarnessIds()], {
  stdio: "inherit",
})
