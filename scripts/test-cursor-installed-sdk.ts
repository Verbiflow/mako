import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorSdkMismatch, cursorSdkInstalledAt, installCursorSdkAt } from "@mako/host/harnesses/cursor/sdk/installed"
import { CURSOR_SDK_PINS } from "@mako/host/harnesses/cursor/sdk/pins"

/**
 * A host made without Cursor carries no `@cursor/sdk`; Settings' install puts one in a folder of Mako's, and the SDK's
 * child loads `installed-sdk.ts` first, so that its imports of the SDK and its platform's build resolve there
 * (`MAKO_CURSOR_SDK_ROOT`). Here that folder holds stand-ins for both, and the imports reach them, not this checkout's.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cursor-sdk-"))
try {
  const standIn = (name: string, files: Record<string, string>) => {
    const folder = join(root, "node_modules", ...name.split("/"))
    mkdirSync(folder, { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text)
  }
  standIn("@cursor/sdk", {
    "package.json": JSON.stringify({ name: "@cursor/sdk", version: "0.0.0", type: "module", exports: { ".": "./index.js", "./sqlite": "./sqlite.js" } }),
    // What the SDK imports itself isn't in that folder: it comes from the host's install.
    "index.js": `import { z } from "zod"\nexport const from = z.literal("installed").value\n`,
    "sqlite.js": `export const from = "installed sqlite"\n`,
  })
  standIn("@cursor/sdk-stand-in", {
    "package.json": JSON.stringify({ name: "@cursor/sdk-stand-in", version: "0.0.0", type: "module", exports: "./index.js" }),
    "index.js": `export const from = "installed build"\n`,
  })
  process.env.MAKO_CURSOR_SDK_ROOT = root
  await import("@mako/host/harnesses/cursor/sdk/installed-sdk")
  for (const [specifier, from] of [["@cursor/sdk", "installed"], ["@cursor/sdk/sqlite", "installed sqlite"], ["@cursor/sdk-stand-in", "installed build"]] as const) {
    const loaded: { from?: string } = await import(specifier)
    assert.equal(loaded.from, from, `${specifier} resolves from the installed folder`)
  }
  // Nothing else moves: a package the folder doesn't hold still comes from the host's install.
  const { z } = await import("zod")
  assert.equal(z.string().parse("host"), "host")
  console.log("cursor installed sdk: the child's SDK imports resolve from the folder Settings installed")

  // A tarball that isn't the build Mako pins is refused before anything of it is unpacked, whatever served it; and a
  // folder isn't usable by holding the right version: only by the mark an install writes once every check passed.
  const install = join(root, "install")
  const served = join(root, "served")
  mkdirSync(join(served, "package"), { recursive: true })
  writeFileSync(join(served, "package", "package.json"), JSON.stringify({ name: "@cursor/sdk", version: CURSOR_SDK_PINS.version, scripts: { install: "touch ran" } }))
  writeFileSync(join(served, "package", "index.js"), `export const from = "another build"\n`)
  execFileSync("tar", ["-czf", join(served, "sdk.tgz"), "-C", served, "package"])
  const asked: string[] = []
  await assert.rejects(
    installCursorSdkAt({
      root: install,
      appRoot: join(import.meta.dirname, ".."),
      env: process.env,
      fetch: async (name, version) => {
        asked.push(`${name}@${version}`)
        return join(served, "sdk.tgz")
      },
    }),
    (error) => error instanceof CursorSdkMismatch && /isn't the build this Mako pins/.test(error.message)
  )
  assert.deepEqual(asked, [`@cursor/sdk@${CURSOR_SDK_PINS.version}`], "the install stops at the first tarball that fails")
  assert.equal(existsSync(join(install, "node_modules")), false, "nothing of a refused tarball is unpacked")
  assert.equal(cursorSdkInstalledAt(install), false)
  const unmarked = join(install, "node_modules", "@cursor", "sdk")
  mkdirSync(unmarked, { recursive: true })
  writeFileSync(join(unmarked, "package.json"), JSON.stringify({ name: "@cursor/sdk", version: CURSOR_SDK_PINS.version }))
  assert.equal(cursorSdkInstalledAt(install), false, "the pinned version without the mark isn't an install")
  writeFileSync(join(install, ".mako-patched"), `${CURSOR_SDK_PINS.version}\n`)
  assert.equal(cursorSdkInstalledAt(install), false, "a mark that isn't of these pins isn't an install")
  console.log("cursor installed sdk: a tarball that isn't the pinned build is refused, and an unmarked folder isn't an install")
} finally {
  delete process.env.MAKO_CURSOR_SDK_ROOT
  rmSync(root, { recursive: true, force: true })
}
