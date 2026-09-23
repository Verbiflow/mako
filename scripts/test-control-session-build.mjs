import assert from "node:assert/strict"
import { build } from "esbuild"
import {
  CONTROL_SESSION_MODULES,
  controlSessionBuild,
} from "../dist-electron/control-session-protocol.js"
const graph = await build({
  entryPoints: [
    "dist-electron/control-session.js",
    "dist-electron/control-session-server.js",
    "dist-electron/browser-service.js",
  ],
  outdir: "/unused",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  write: false,
  metafile: true,
  logLevel: "silent",
})
const modules = Object.keys(graph.metafile.inputs)
  .map((path) => path.replace("dist-electron/", "").replace(/\.js$/, ""))
  .sort()
assert.deepEqual(
  [...CONTROL_SESSION_MODULES].sort(),
  modules,
  "Update the engine identity when its dependency graph changes"
)
assert.match(await controlSessionBuild(), /^[a-f0-9]{64}$/)
assert.equal(await controlSessionBuild(), await controlSessionBuild())
console.log(
  "Control session identity covers the complete local engine graph and compiled @mako/control modules"
)
