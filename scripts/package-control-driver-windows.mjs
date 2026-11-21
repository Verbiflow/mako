// Build the shared native driver for Windows x64 from the pinned upstream source and Mako's reviewed patch, the way
// package-control-driver-linux.mjs builds Linux: one executable with the C runtime linked in, its architecture, its
// imports and every crate's license checked, and its provenance recorded beside it.
//
//   node scripts/package-control-driver-windows.mjs <pinned source checkout> [--target-dir=<cargo target dir>]
//
// Run it on Windows with Rust (the source's rust-toolchain.toml picks the version) and MSVC's build tools.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
assert.equal(process.platform, "win32", "The Windows driver is built on Windows")
const [source, ...options] = process.argv.slice(2)
assert.ok(source, "Usage: node scripts/package-control-driver-windows.mjs <pinned source checkout> [--target-dir=<dir>]")
assert.ok(options.every((arg) => /^--target-dir=.+$/.test(arg)), "The only option is --target-dir=<dir>")
const root = resolve(source)
const rust = join(root, "libs/cua-driver/rust")
const targetDir = resolve(options.find((arg) => arg.startsWith("--target-dir="))?.slice(13) ?? join(rust, "target"))
const manifest = JSON.parse(await readFile("vendor/cua-driver/release.json", "utf8"))
const patch = await readFile(join("vendor/cua-driver", manifest.patch), "utf8")
const hash = (data) => createHash("sha256").update(data).digest("hex")
// Line endings aside (a Windows checkout may convert them), the source is the pinned base plus the reviewed patch.
const normalized = (text) => text.replaceAll("\r\n", "\n")

async function verifySource() {
  assert.equal((await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(), manifest.base)
  const actual = (await run("git", ["-C", root, "diff", "HEAD", "--", "libs/cua-driver/rust", "libs/cua-driver/wayland-helper"], { maxBuffer: 16 * 1024 * 1024 })).stdout
  assert.equal(hash(normalized(actual)), hash(normalized(patch)), "Native source differs from the pinned base plus the reviewed patch")
}

/** The DLLs a PE executable imports, and its machine. */
function peImports(image) {
  const pe = image.readUInt32LE(0x3c)
  assert.equal(image.toString("latin1", pe, pe + 4), "PE\0\0", "not a PE executable")
  const machine = image.readUInt16LE(pe + 4)
  const sections = image.readUInt16LE(pe + 6)
  const optionalSize = image.readUInt16LE(pe + 20)
  const optional = pe + 24
  assert.equal(image.readUInt16LE(optional), 0x20b, "not a PE32+ executable")
  const importRva = image.readUInt32LE(optional + 112 + 8)
  const table = optional + optionalSize
  const offset = (rva) => {
    for (let index = 0; index < sections; index++) {
      const section = table + index * 40
      const virtualAddress = image.readUInt32LE(section + 12)
      const size = Math.max(image.readUInt32LE(section + 8), image.readUInt32LE(section + 16))
      if (rva >= virtualAddress && rva < virtualAddress + size) return rva - virtualAddress + image.readUInt32LE(section + 20)
    }
    throw new Error(`RVA ${rva} is in no section`)
  }
  const dlls = []
  for (let entry = offset(importRva); image.readUInt32LE(entry + 12) !== 0; entry += 20) {
    const name = offset(image.readUInt32LE(entry + 12))
    dlls.push(image.toString("latin1", name, image.indexOf(0, name)).toLowerCase())
  }
  return { machine, dlls }
}

/** Every crate the Windows driver links, with its license; none may be GPL without another license to take. */
async function licenses() {
  const metadata = JSON.parse((await run("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-pc-windows-msvc"], { cwd: rust, maxBuffer: 64 * 1024 * 1024 })).stdout)
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]))
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const start = metadata.packages.find((entry) => entry.name === "cua-driver")
  const seen = new Set()
  const queue = [start.id]
  while (queue.length) {
    const id = queue.pop()
    if (seen.has(id)) continue
    seen.add(id)
    // Build scripts and tests don't ship; what the executable links does.
    for (const dep of nodes.get(id)?.deps ?? []) if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg)
  }
  // Cua's own crates declare no license of their own: the repository's LICENSE.md (MIT) covers them, and ships beside the
  // executable. MPL-2.0 crates are unmodified from crates.io, where their source is.
  const linked = [...seen].map((id) => packages.get(id)).map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license ?? (entry.source === null ? "MIT (Cua LICENSE.md)" : entry.license_file ? `file:${entry.license_file}` : "unknown"),
  }))
  const copyleft = linked.filter(({ license }) => /\bA?GPL\b|\bLGPL\b/.test(license) && !license.split(/\s+OR\s+/i).some((alternative) => !/GPL/.test(alternative)))
  assert.deepEqual(copyleft, [], `GPL-only crates in the Windows driver: ${JSON.stringify(copyleft)}`)
  const unknown = linked.filter(({ license }) => license === "unknown")
  assert.deepEqual(unknown, [], `Crates without a license: ${JSON.stringify(unknown)}`)
  return linked.sort((left, right) => left.name.localeCompare(right.name))
}

await verifySource()
await run("cargo", ["build", "--release", "--locked", "-p", "cua-driver"], {
  cwd: rust,
  env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: "-C target-feature=+crt-static" },
  timeout: 3_600_000,
  maxBuffer: 64 * 1024 * 1024,
})
await verifySource()
const built = join(targetDir, "release", "cua-driver.exe")
const version = (await run(built, ["--version"])).stdout.trim()
assert.equal(version, `cua-driver ${manifest.version}`)
const binary = await readFile(built)
const { machine, dlls } = peImports(binary)
assert.equal(machine, 0x8664, "The executable is not x64")
// Linked statically, the C runtime is not an import: a machine without the Visual C++ redistributable runs it.
const runtime = dlls.filter((dll) => /^(vcruntime|msvcp|ucrtbase|api-ms-win-crt-)/.test(dll))
assert.deepEqual(runtime, [], `The executable imports the C runtime: ${runtime.join(", ")}`)
// No FFmpeg in the Windows build: none of its capture or encoder names, its Windows package or its executable's name is
// in the binary. The word itself stays only in text (the `install_ffmpeg` tool that refuses, and messages that say
// none is used); each place is recorded for review.
const text = binary.toString("latin1")
const forbidden = ["gdigrab", "x11grab", "libx264", "Gyan.FFmpeg", "ffmpeg.exe", "ffprobe"].filter((word) => text.includes(word))
assert.deepEqual(forbidden, [], `FFmpeg's names are in the Windows executable: ${forbidden.join(", ")}`)
const ffmpegMentions = [...text.matchAll(/[\x20-\x7e]{0,40}ffmpeg[\x20-\x7e]{0,40}/g)].map((match) => match[0])
const linked = await licenses()
const output = resolve("release/control-driver", manifest.version, "windows-x64")
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(built, join(output, "cua-driver.exe"))
await cp(join(root, "LICENSE.md"), join(output, "LICENSE-Cua.md"))
const rustc = (await run("rustc", ["--version"], { cwd: rust })).stdout.trim()
await writeFile(
  join(output, "provenance.json"),
  JSON.stringify(
    {
      base: manifest.base,
      version: manifest.version,
      platform: "windows-x64",
      rustc,
      rustflags: "-C target-feature=+crt-static",
      patchSha256: hash(patch),
      binarySha256: hash(binary),
      bytes: binary.length,
      imports: dlls,
      ffmpegMentions,
      licenses: Object.entries(Object.groupBy(linked, ({ license }) => license)).map(([license, crates]) => ({ license, crates: crates.map(({ name, version }) => `${name} ${version}`) })),
      builtAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n"
)
console.log(output)
