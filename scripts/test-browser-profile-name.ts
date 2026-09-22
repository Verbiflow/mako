import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  singleBrowserProfile,
  browserProfileName,
} from "../electron/browser-profile-name.js"
const root = await mkdtemp(join(tmpdir(), "mako-profile-names-"))
try {
  await mkdir(join(root, "Default"))
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Old name" } } },
    })
  )
  await writeFile(
    join(root, "Default", "Preferences"),
    JSON.stringify({ profile: { name: "Work" } })
  )
  assert.equal(await singleBrowserProfile(root), join(root, "Default"))
  assert.equal(await browserProfileName(join(root, "Default")), "Work")
  await writeFile(
    join(root, "Default", "Preferences"),
    JSON.stringify({ profile: { name: "Personal" } })
  )
  assert.equal(
    await browserProfileName(join(root, "Default")),
    "Personal",
    "Refresh reads a real profile rename"
  )
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({
      profile: {
        last_used: "Default",
        info_cache: { Default: {}, "Profile 1": {} },
      },
    })
  )
  assert.equal(
    await singleBrowserProfile(root),
    undefined,
    "Multiple profiles never use last-used as identity"
  )
  await writeFile(
    join(root, "Local State"),
    JSON.stringify({ profile: { info_cache: { "../escape": {} } } })
  )
  assert.equal(await singleBrowserProfile(root), undefined)
  await writeFile(join(root, "Default", "Preferences"), "malformed")
  assert.equal(await browserProfileName(join(root, "Default")), undefined)
  console.log(
    "PASS: actual profile names, renames, ambiguity refusal, malformed metadata and path confinement"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
