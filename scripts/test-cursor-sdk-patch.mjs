import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { createPackage, extractFile } from "@electron/asar"
import { assertCursorSdkPatched, CURSOR_SDK_PATCHES, patchCursorSdk } from "./patch-cursor-sdk.mjs"

const installed = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "../..")
const root = mkdtempSync(join(tmpdir(), "mako-cursor-patch-"))
const sdk = join(root, "app/node_modules/@cursor/sdk")
const read = (file) => readFileSync(join(sdk, file), "utf8")
try {
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, "package.json"), readFileSync(join(installed, "package.json")))
  // Model the Settings checkout's cached, unpatched dependency tree without
  // changing the real dependency. Use this version's actual SDK bytes.
  for (const { target, replacements } of CURSOR_SDK_PATCHES) {
    let source = readFileSync(join(installed, target), "utf8")
    for (const [original, patched] of replacements) {
      assert.equal(source.split(patched).length - 1, 1)
      source = source.replace(patched, () => original)
    }
    mkdirSync(dirname(join(sdk, target)), { recursive: true })
    writeFileSync(join(sdk, target), source)
  }
  assert.throws(() => assertCursorSdkPatched(read), /lacks Mako's complete/)
  patchCursorSdk(sdk)
  const first = CURSOR_SDK_PATCHES.map(({ target }) => read(target))
  patchCursorSdk(sdk)
  assert.deepEqual(CURSOR_SDK_PATCHES.map(({ target }) => read(target)), first, "repeated builds leave patched bytes unchanged")
  const archive = join(root, "app.asar")
  await createPackage(join(root, "app"), archive)
  assertCursorSdkPatched((target) => extractFile(archive, `node_modules/@cursor/sdk/${target}`).toString("utf8"))
  const { target, replacements } = CURSOR_SDK_PATCHES[0]
  const [original, patched] = replacements[1]
  writeFileSync(join(sdk, target), read(target).replace(patched, () => original))
  assert.throws(() => assertCursorSdkPatched(read), /lacks Mako's complete/, "the marker alone cannot hide a partial patch")
  assert.throws(() => patchCursorSdk(sdk), /incomplete or older/)
  const incompleteArchive = join(root, "incomplete.asar")
  await createPackage(join(root, "app"), incompleteArchive)
  assert.throws(() => assertCursorSdkPatched((file) => extractFile(incompleteArchive, `node_modules/@cursor/sdk/${file}`).toString("utf8")), /lacks Mako's complete/, "the package gate checks the archive, not development dependencies")
  console.log("Cursor SDK patch: cached unpatched tree repaired, repeat build idempotent, incomplete patch refused, actual ASAR checked")
} finally {
  rmSync(root, { recursive: true, force: true })
}
