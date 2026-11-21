#!/usr/bin/env node
// Builds mako-video, Mako's video helper (packages/control-runtime/src/video-helper.ts), for this machine:
//
//   macOS  native/video-macos/main.swift: ScreenCaptureKit and VideoToolbox. Shipped in the app's Contents/MacOS;
//          a checkout's hosts share this build, which `build:electron` makes.
//   Linux  native/video-linux/mako-video.c against the system's X11, OpenH264, libyuv and libjpeg-turbo (Debian:
//          libx11-dev libxext-dev libxdamage-dev libxfixes-dev libxcomposite-dev libopenh264-dev libyuv-dev
//          libturbojpeg0-dev). The machine image compiles it the same way (runtime/host/Dockerfile). Where GIO and
//          PipeWire's headers are installed too (libglib2.0-dev libpipewire-0.3-dev), it also captures through the
//          ScreenCast portal, as a Wayland desktop needs; --portal requires them.
//   Windows native/video-windows/mako-video.cpp: Windows Graphics Capture and Media Foundation, with MSVC from the
//          Visual Studio Build Tools (found with vswhere) and the Windows SDK's C++/WinRT headers. The C runtime is
//          linked in (/MT), so the .exe needs nothing beside it but Windows 10 1903 or later.
//
// Output: build/mako-video (build/mako-video.exe on Windows), or --output <path>. Skipped where the compiler or a
// library is missing, unless --require; the source being older than the output skips it too (--if-fresh).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const require = args.includes("--require")
const portal = args.includes("--portal")
const index = args.indexOf("--output")
const windows = process.platform === "win32"
const output = index === -1 ? join(root, windows ? "build/mako-video.exe" : "build/mako-video") : resolve(args[index + 1])
const source = join(root, {
  darwin: "native/video-macos/main.swift",
  win32: "native/video-windows/mako-video.cpp",
}[process.platform] ?? "native/video-linux/mako-video.c")

function skip(reason) {
  if (require) throw new Error(`mako-video can't be built here: ${reason}`)
  console.warn(`[video-helper] ${reason}; skipped`)
  process.exit(0)
}
if (!["darwin", "linux", "win32"].includes(process.platform)) skip(`no helper for ${process.platform}`)

/** MSVC's environment for this machine's architecture: the newest Visual Studio with the C++ tools, through vswhere. */
function msvc() {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe")
  const install = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
  if (!install) throw new Error("no Visual Studio with the C++ build tools (vswhere found none)")
  return { vcvars: join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat"), arch: process.arch === "arm64" ? "arm64" : "x64" }
}
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
  else if (windows) {
    const { vcvars, arch } = msvc()
    const objects = mkdtempSync(join(tmpdir(), "mako-video-obj-"))
    const compile = ["cl", "/nologo", "/O2", "/MT", "/std:c++20", "/EHsc", "/permissive-", "/W3", "/DUNICODE", "/D_UNICODE", `/Fo${objects}\\`, source, `/Fe${output}`, "/link", "/SUBSYSTEM:CONSOLE"]
    // cmd runs vcvarsall for the compiler's environment, then cl, as one command line it reads verbatim.
    const line = [`call "${vcvars}" ${arch} >nul`, compile.map((part) => (/[\s"]/.test(part) ? `"${part}"` : part)).join(" ")].join(" && ")
    try {
      execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { stdio: "inherit", windowsVerbatimArguments: true })
    } finally {
      rmSync(objects, { recursive: true, force: true })
    }
  } else {
    const libraries = (names) => execFileSync("pkg-config", ["--cflags", "--libs", ...names], { encoding: "utf8" }).trim().split(/\s+/)
    const flags = libraries(["x11", "xext", "xdamage", "xfixes", "xcomposite", "openh264", "libturbojpeg"])
    const portalNames = ["gio-2.0", "gio-unix-2.0", "libpipewire-0.3"]
    let portalFlags = []
    try {
      portalFlags = ["-DMAKO_PORTAL", ...libraries(portalNames)]
    } catch (error) {
      if (portal) throw error
      console.warn(`[video-helper] no ${portalNames.join(", ")}: built without ScreenCast portal capture`)
    }
    execFileSync("cc", ["-O2", "-Wall", "-Werror", "-o", output, source, ...flags, ...portalFlags, "-lyuv", "-lm"], { stdio: "inherit" })
  }
} catch (error) {
  skip(error instanceof Error ? error.message.split("\n")[0] : String(error))
}
if (!windows) execFileSync("chmod", ["755", output])
console.log(`[video-helper] built ${output}`)
