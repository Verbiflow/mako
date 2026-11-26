import { build } from "esbuild"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

const root = testScratch("mako-application-runtime-")
await mkdir(join(root, "profile"))
await symlink(resolve("node_modules"), join(root, "node_modules"))
await writeFile(
  join(root, "package.json"),
  JSON.stringify({
    name: "mako-lifecycle-fixture",
    version: "0.0.1",
    type: "module",
    main: "check.mjs",
  })
)
await build({
  entryPoints: ["scripts/application-runtime-check.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // The host is installed beside the app, as in a real one: its environment finds the app above the package.
  external: ["@mako/host", "@mako/host/*"],
  outfile: join(root, "check.mjs"),
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
process.exitCode = await runElectronCheck("application runtime", [root], { env, ms: 45_000 })
console.log(`Isolated lifecycle runtime: ${root}`)
