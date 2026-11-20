#!/usr/bin/env node
// Builds mako-video, Mako's video helper (packages/control-runtime/src/video-helper.ts), for this machine:
//
//   macOS  native/video-macos/main.swift: ScreenCaptureKit and VideoToolbox. Shipped in the app's Contents/MacOS;
//          a checkout's hosts share this build, which `build:electron` makes.
//   Linux  native/video-linux/mako-video.c against the system's X11, OpenH264, libyuv and libjpeg-turbo (Debian:
//          libx11-dev libxext-dev libxdamage-dev libxfixes-dev libxcomposite-dev libopenh264-dev libyuv-dev
//          libturbojpeg0-dev). The machine image compiles it the same way (runtime/host/Dockerfile).
//
// Output: build/mako-video, or --output <path>. Skipped where the compiler or a library is missing, unless --require;
// the source being older than the output skips it too (--if-fresh).
import { execFileSync } from "node:child_process"
import { mkdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const require = args.includes("--require")
const index = args.indexOf("--output")
const output = index === -1 ? join(root, "build/mako-video") : resolve(args[index + 1])
const source = join(root, process.platform === "darwin" ? "native/video-macos/main.swift" : "native/video-linux/mako-video.c")

function skip(reason) {
  if (require) throw new Error(`mako-video can't be built here: ${reason}`)
  console.warn(`[video-helper] ${reason}; skipped`)
  process.exit(0)
}
if (process.platform !== "darwin" && process.platform !== "linux") skip(`no helper for ${process.platform}`)
if (args.includes("--if-fresh")) {
  const built = statSync(output, { throwIfNoEntry: false })
  if (built && built.mtimeMs >= statSync(source).mtimeMs) {
    console.log(`[video-helper] ${output} is current`)
    process.exit(0)
  }
}
mkdirSync(dirname(output), { recursive: true })
try {
  if (process.platform === "darwin")
    // ScreenCaptureKit's window filter and point scale need macOS 14.
    execFileSync("xcrun", ["swiftc", "-O", "-swift-version", "5", source, "-target", "arm64-apple-macosx14.0", "-o", output], { stdio: "inherit" })
  else {
    const flags = execFileSync("pkg-config", ["--cflags", "--libs", "x11", "xext", "xdamage", "xfixes", "xcomposite", "openh264", "libturbojpeg"], { encoding: "utf8" }).trim().split(/\s+/)
    execFileSync("cc", ["-O2", "-Wall", "-Werror", "-o", output, source, ...flags, "-lyuv", "-lm"], { stdio: "inherit" })
  }
} catch (error) {
  skip(error instanceof Error ? error.message.split("\n")[0] : String(error))
}
execFileSync("chmod", ["755", output])
console.log(`[video-helper] built ${output}`)
