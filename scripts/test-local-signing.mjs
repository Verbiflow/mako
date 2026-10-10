import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { createPackage } from "@electron/asar"
import {
  localMacConfig,
  resolveLocalIdentity,
  verifyLocalSignature,
} from "./mac-local-signing.mjs"

const run = promisify(execFile)
const identity = "0123456789ABCDEF0123456789ABCDEF01234567"
const release = {
  appId: "dev.mako.app",
  extraMetadata: {
    main: "dist-electron/entry.js",
    makoDistribution: "unsigned",
  },
  mac: {
    identity: "-",
    hardenedRuntime: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
  },
  publish: [{ provider: "github", owner: "fixture", repo: "fixture" }],
}
const before = structuredClone(release)
const local = localMacConfig(release, identity)
assert.deepEqual(release, before)
assert.equal(local.mac.identity, identity)
assert.equal(local.mac.hardenedRuntime, true)
assert.equal(local.mac.entitlements, release.mac.entitlements)
assert.equal(local.mac.notarize, false)
assert.equal(local.mac.timestamp, "none")
assert.equal(local.forceCodeSigning, true)
assert.equal(local.publish, null)
assert.equal(local.extraMetadata.main, release.extraMetadata.main)
assert.equal(local.extraMetadata.makoDistribution, "local")
assert.equal(local.extraMetadata.makoLocalSigningIdentity, identity)
for (const invalid of [
  "",
  "-",
  "AMA Local Development",
  "0".repeat(39),
  "G".repeat(40),
])
  assert.throws(() => localMacConfig(release, invalid))

const selected = process.argv
  .find((arg) => arg.startsWith("--identity="))
  ?.slice(11)
if (selected) {
  assert.equal(process.platform, "darwin")
  localMacConfig(release, selected)
  const root = await mkdtemp(join(tmpdir(), "mako-signing-test-"))
  async function fixture(name, value, signer) {
    const app = join(root, `${name}.app`)
    const contents = join(app, "Contents")
    await mkdir(join(contents, "MacOS"), { recursive: true })
    await writeFile(
      join(contents, "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.mako.app</string><key>CFBundleExecutable</key><string>Mako</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
    )
    const source = join(root, `${name}.c`)
    await writeFile(source, `int main(void) { return ${value}; }\n`)
    await run("clang", [source, "-o", join(contents, "MacOS/Mako")])
    const payload = join(root, `${name}-payload`)
    await mkdir(payload)
    await writeFile(
      join(payload, "package.json"),
      JSON.stringify(localMacConfig(release, selected).extraMetadata)
    )
    await mkdir(join(contents, "Resources"))
    await createPackage(payload, join(contents, "Resources/app.asar"))
    await run("codesign", [
      "--force",
      "--sign",
      signer,
      "--options",
      "runtime",
      "--timestamp=none",
      app,
    ])
    return app
  }
  try {
    const first = await fixture("first", 0, selected)
    const second = await fixture("second", 1, selected)
    const adhoc = await fixture("adhoc", 0, "-")
    const firstSignature = await verifyLocalSignature(first, selected)
    const secondSignature = await verifyLocalSignature(second, selected, first)
    assert.notEqual(firstSignature.cdhash, secondSignature.cdhash)
    assert.equal(firstSignature.requirement, secondSignature.requirement)
    await assert.rejects(verifyLocalSignature(adhoc, selected))
    await assert.rejects(verifyLocalSignature(first, identity))
    assert.equal(
      await resolveLocalIdentity(undefined, first),
      selected.toUpperCase()
    )
    assert.equal(
      await resolveLocalIdentity(selected.toLowerCase()),
      selected.toUpperCase()
    )
    await assert.rejects(resolveLocalIdentity(undefined, adhoc))
    await assert.rejects(
      resolveLocalIdentity(undefined, join(root, "missing.app")),
      /MAKO_LOCAL_SIGNING_IDENTITY/
    )
    const { replacePreparedApplication } =
      await import("@mako/host/application/local-update-installer")
    const staging = join(root, "signed-replacement")
    const target = join(root, "installed.app")
    await mkdir(staging)
    await cp(first, target, { recursive: true, verbatimSymlinks: true })
    await cp(second, join(staging, "Mako.app"), {
      recursive: true,
      verbatimSymlinks: true,
    })
    const backup = await replacePreparedApplication({
      staging,
      target,
      ready: async () => {},
      verify: (path) => verifyLocalSignature(path, selected),
    })
    assert.equal(
      (await verifyLocalSignature(target, selected)).cdhash,
      secondSignature.cdhash
    )
    assert.equal(
      (await verifyLocalSignature(backup, selected)).cdhash,
      firstSignature.cdhash
    )
    const rollback = join(root, "signed-rollback")
    await mkdir(rollback)
    await cp(first, join(rollback, "Mako.app"), {
      recursive: true,
      verbatimSymlinks: true,
    })
    await assert.rejects(
      replacePreparedApplication({
        staging: rollback,
        target,
        ready: async () => {},
        verify: async (path) => {
          if (path === target)
            await writeFile(
              join(path, "Contents/Info.plist"),
              "damaged during replacement"
            )
          await verifyLocalSignature(path, selected)
        },
      })
    )
    assert.equal(
      (await verifyLocalSignature(target, selected)).cdhash,
      secondSignature.cdhash
    )
    console.log(
      "Real signed replacement and post-swap signature-failure rollback preserve the exact previous binary"
    )
    await writeFile(join(first, "Contents/Info.plist"), "invalidated signature")
    await assert.rejects(resolveLocalIdentity(undefined, first))
    console.log(
      "Changed native binaries retain the same certificate-backed identity; ad-hoc, tampered, and wrong-signer builds are rejected; verified installed identity is reused"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
console.log(
  "Local packaging preserves release configuration, requires an explicit signer, and keeps public updates disabled"
)
