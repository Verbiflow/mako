#!/usr/bin/env node
// Builds mako-windows.exe, the Win32 helper Mako's host on Windows runs by its whole path
// (native/windows-helper/mako-windows.c, packages/host/src/base/windows-helper.ts): a C program built with MSVC from
// the Visual Studio Build Tools (found with vswhere), its C runtime linked in (/MT), so it needs nothing beside it.
// A package ships it beside the app's executable; a checkout's hosts use build/mako-windows.exe.
//
// Output: build/mako-windows.exe, or --output <path>. Nothing to do off Windows; skipped where MSVC is missing unless
// --require; the source being older than the output skips it too (--if-fresh).
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const require = args.includes("--require")
const index = args.indexOf("--output")
const output = index === -1 ? join(root, "build", "mako-windows.exe") : resolve(args[index + 1])
const source = join(root, "native", "windows-helper", "mako-windows.c")

function skip(reason) {
  if (require) throw new Error(`mako-windows can't be built here: ${reason}`)
  console.warn(`[windows-helper] ${reason}; skipped`)
  process.exit(0)
}
if (process.platform !== "win32") {
  if (require) skip("it is a Windows program")
  process.exit(0)
}
if (args.includes("--if-fresh")) {
  const built = statSync(output, { throwIfNoEntry: false })
  if (built && built.mtimeMs >= statSync(source).mtimeMs) {
    console.log(`[windows-helper] ${output} is current`)
    process.exit(0)
  }
}
mkdirSync(dirname(output), { recursive: true })
const objects = mkdtempSync(join(tmpdir(), "mako-windows-obj-"))
try {
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe")
  const install = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
  if (!install) throw new Error("no Visual Studio with the C++ build tools (vswhere found none)")
  const vcvars = join(install, "VC", "Auxiliary", "Build", "vcvarsall.bat")
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const compile = ["cl", "/nologo", "/O2", "/MT", "/W4", "/WX", "/DUNICODE", "/D_UNICODE", `/Fo${objects}\\`, source, `/Fe${output}`, "/link", "/SUBSYSTEM:CONSOLE", "advapi32.lib"]
  // cmd runs vcvarsall for the compiler's environment, then cl, as one command line it reads verbatim.
  const line = [`call "${vcvars}" ${arch} >nul`, compile.map((part) => (/[\s"]/.test(part) ? `"${part}"` : part)).join(" ")].join(" && ")
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  execFileSync(join(systemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", `"${line}"`], { stdio: "inherit", windowsVerbatimArguments: true })
} catch (error) {
  skip(error instanceof Error ? error.message.split("\n")[0] : String(error))
} finally {
  rmSync(objects, { recursive: true, force: true })
}
console.log(`[windows-helper] built ${output}`)
