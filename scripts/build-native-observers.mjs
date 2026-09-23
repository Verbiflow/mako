import { build } from "esbuild"

// Native runtimes cannot import Mako's ASAR or node_modules. Ship the observer
// with its validated boundary bundled, then materialize it for each launch.
await build({
  entryPoints: ["electron/providers/opencode/native-approval-plugin.ts"],
  // Keep bundler-owned output separate from TypeScript's incremental emit.
  outfile: "dist-electron/providers/opencode/native-approval-plugin.bundle.mjs",
  bundle: true, platform: "node", format: "esm", target: "node22", minify: true,
})
