import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = await mkdtemp(join(tmpdir(), "mako-application-runtime-"))
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
const child = spawn(resolve("node_modules/.bin/electron"), [root], {
  env,
  stdio: "inherit",
})
const timer = setTimeout(() => child.kill(), 45_000)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} finally {
  clearTimeout(timer)
}
console.log(`Isolated lifecycle runtime: ${root}`)
