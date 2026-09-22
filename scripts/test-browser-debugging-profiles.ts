import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  debuggingBrowsers,
  debuggingEndpoint,
} from "../electron/browser-debugging-profiles.js"
const base = await mkdtemp(join(tmpdir(), "mako-debug-profiles-"))
try {
  const root = join(base, "Vendor", "Unlisted Chromium Fork")
  await mkdir(root, { recursive: true })
  const state = JSON.stringify({ profile: { info_cache: { Default: {} } } })
  await writeFile(join(root, "Local State"), state)
  assert.deepEqual(
    await debuggingBrowsers(base),
    [],
    "Ordinary profiles are not enabled implicitly"
  )
  const file = join(root, "DevToolsActivePort")
  await writeFile(file, "54250\n/devtools/browser/current-id\n")
  const [browser] = await debuggingBrowsers(base)
  assert.ok(browser)
  assert.match(browser.name, /Unlisted Chromium Fork/)
  assert.equal(browser.requiresApproval, true)
  assert.equal(
    await browser.endpoint(),
    "ws://127.0.0.1:54250/devtools/browser/current-id"
  )
  await writeFile(file, "54251\n/devtools/browser/rotated-id\n")
  assert.equal(
    await browser.endpoint(),
    "ws://127.0.0.1:54251/devtools/browser/rotated-id",
    "Resolve the latest endpoint at connection time"
  )
  assert.equal(
    (await debuggingBrowsers(base))[0].id,
    browser.id,
    "Profile identity survives restart"
  )
  for (const invalid of [
    "0\n/devtools/browser/id",
    "65536\n/devtools/browser/id",
    "42x\n/devtools/browser/id",
    "80\n//remote.example/path",
    "80\n/devtools/browser/id?redirect=1",
    "80\n/devtools/browser/id\nextra",
    "x".repeat(1025),
  ]) {
    await writeFile(file, invalid)
    await assert.rejects(debuggingEndpoint(root))
    assert.deepEqual(await debuggingBrowsers(base), [])
  }
  await writeFile(file, "54250\n/devtools/browser/id")
  await writeFile(join(root, "Local State"), "{}")
  assert.deepEqual(
    await debuggingBrowsers(base),
    [],
    "Non-Chromium app data is excluded"
  )
  await writeFile(join(root, "Local State"), state)
  await rm(file)
  await symlink(join(root, "Local State"), file)
  assert.deepEqual(
    await debuggingBrowsers(base),
    [],
    "Do not follow endpoint-file symlinks"
  )
  await assert.rejects(
    browser.endpoint(),
    "A vanished endpoint cannot silently select another browser"
  )
} finally {
  await rm(base, { recursive: true })
}
console.log(
  "Regular Chromium discovery: explicit enabling, arbitrary brands, endpoint rotation, malformed input and missing targets passed"
)
