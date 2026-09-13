#!/usr/bin/env node
// Builds the mako-notification-status helper for macOS packaging.
//
// The helper (native/notification-status-macos/main.swift) reads this app's
// UNUserNotificationCenter settings, which Electron cannot. It must run from
// Contents/MacOS inside the bundle and carry the app's bundle identifier as an
// embedded __TEXT,__info_plist section, so every later `codesign --force`
// (electron-builder's pass, the local signer) derives the same code
// identifier that macOS keys notification records to.
//
// Output: build/mako-notification-status (arm64, matching the app target).
// Skipped on other platforms and when swiftc is missing, unless --require.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const require = args.includes("--require")
const output = readArg("--output") ?? join(root, "build/mako-notification-status")
const bundleId = readArg("--bundle-id") ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).build.appId

if (process.platform !== "darwin") {
  if (require) throw new Error("The notification status helper builds only on macOS")
  process.exit(0)
}
// Invoked through xcrun so the SDK resolves; the bare compiler path cannot
// load the standard library for the target.
try {
  execFileSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" })
} catch {
  if (require) throw new Error("swiftc is required to build the notification status helper; install the Command Line Tools")
  console.warn("[notification-status] swiftc unavailable; the packaged app will infer authorization from delivery")
  process.exit(0)
}

const work = join(tmpdir(), `mako-notification-status-${process.pid}`)
mkdirSync(work, { recursive: true })
try {
  const plist = join(work, "Info.plist")
  writeFileSync(plist, embeddedInfoPlist(bundleId))
  mkdirSync(dirname(output), { recursive: true })
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      join(root, "native/notification-status-macos/main.swift"),
      "-target",
      "arm64-apple-macosx12.0",
      "-o",
      output,
      "-Xlinker", "-sectcreate",
      "-Xlinker", "__TEXT",
      "-Xlinker", "__info_plist",
      "-Xlinker", plist,
    ],
    { stdio: "inherit" }
  )
  execFileSync("chmod", ["755", output])
  console.log(`[notification-status] built ${output} for ${bundleId}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function readArg(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function embeddedInfoPlist(identifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleName</key>
  <string>mako-notification-status</string>
</dict>
</plist>
`
}
