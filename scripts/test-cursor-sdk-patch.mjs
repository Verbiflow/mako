import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
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
  // An existing complete transcript patch upgrades without reinstalling;
  // incomplete historical patches still fail below.
  const esm = CURSOR_SDK_PATCHES.find(({ target }) => target === "dist/esm/357.js")
  const [reposOriginal, reposPatched] = esm.replacements.at(-1)
  writeFileSync(join(sdk, esm.target), read(esm.target).replace(reposPatched, () => reposOriginal))
  patchCursorSdk(sdk)
  assert.deepEqual(CURSOR_SDK_PATCHES.map(({ target }) => read(target)), first)
  // Execute the exact method present in both SDK formats, without a network
  // or account: policy callers still get the same response or rejection.
  const marker = Symbol.for("mako.cursor-sdk.team-repos-unavailable")
  for (const { target, replacements } of CURSOR_SDK_PATCHES.filter(({ change }) => change.includes("rejection origin"))) {
    const [, method] = replacements.at(-1)
    const source = read(target)
    assert.ok(source.includes(method))
    const provider = runInNewContext(`({${source.slice(source.indexOf(method), source.indexOf(method) + method.length)}})`, {
      Zc: { aYW: class {} }, rS: { aYW: class {} }, Error, Object, Symbol,
    })
    const response = { repos: [{ url: "blocked.invalid", patterns: [{ pattern: "**" }] }] }
    provider.dashboardClient = { getTeamReposOrEmptyIfNotInTeam: () => Promise.resolve(response) }
    assert.equal(await provider.getTeamRepos(), response, "repository restrictions pass through untouched")
    for (const error of [
      Object.assign(new Error("fixture unavailable"), { name: "ConnectError", code: 14 }),
      Object.assign(new Error("fixture auth"), { name: "ConnectError", code: 16 }),
      new TypeError("fixture programming error"),
      Object.freeze(Object.assign(new Error("fixture frozen"), { name: "ConnectError", code: 14 })),
    ]) {
      provider.dashboardClient = { getTeamReposOrEmptyIfNotInTeam: () => Promise.reject(error) }
      await assert.rejects(provider.getTeamRepos(), (rejected) => rejected === error, "the original policy failure still propagates")
      assert.equal(error[marker] === true, error.code === 14 && Object.isExtensible(error))
      assert.ok(!JSON.stringify(error).includes("mako"), "the origin marker never serializes")
    }
  }
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
