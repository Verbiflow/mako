#!/usr/bin/env node
// Builds the mako-sleep-watch helper for macOS packaging.
//
// The helper (native/sleep-watch-macos/main.swift) hears the Mac's sleep before it happens and holds it briefly while
// the host hands agents at work to the cloud (`SleepHandOff` in packages/host/src/conversations/sleep-handoff.ts). It
// ships beside the executable in Contents/MacOS, where the host looks for it; a checkout builds its own on first use.
//
// Output: build/mako-sleep-watch (arm64, matching the app target).
// Skipped on other platforms and when swiftc is missing, unless --require.
import { execFileSync } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const require = args.includes("--require")
const index = args.indexOf("--output")
const output = index === -1 ? join(root, "build/mako-sleep-watch") : args[index + 1]
const source = join(root, "native/sleep-watch-macos/main.swift")

if (process.platform !== "darwin") {
  if (require) throw new Error("The sleep watch helper builds only on macOS")
  process.exit(0)
}
if (args.includes("--if-fresh")) {
  const built = statSync(output, { throwIfNoEntry: false })
  if (built && built.mtimeMs >= statSync(source).mtimeMs) {
    console.log(`[sleep-watch] ${output} is current`)
    process.exit(0)
  }
}
// Invoked through xcrun so the SDK resolves; the bare compiler path cannot load the standard library for the target.
try {
  execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" })
} catch {
  if (require) throw new Error("swiftc is required to build the sleep watch helper; install the Command Line Tools")
  console.warn("[sleep-watch] swiftc unavailable; agents won't be handed off on sleep")
  process.exit(0)
}
mkdirSync(dirname(output), { recursive: true })
execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-target", "arm64-apple-macosx12.0", "-o", output], { stdio: "inherit" })
execFileSync("chmod", ["755", output])
console.log(`[sleep-watch] built ${output}`)
