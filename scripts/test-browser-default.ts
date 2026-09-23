import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { macApplicationBundle } from "../electron/browser-application.js"
import type { LocalBrowser } from "../packages/control-runtime/src/browser-discovery.js"

const root = await mkdtemp(join(tmpdir(), "mako-default-browser-"))
const path = "/Applications/Unknown Chromium Brand.app"
let connects = 0
const browser: LocalBrowser = {
  id: "unknown",
  name: "Unknown · Work",
  kind: "chromium",
  transport: "extension",
  applicationPath: path,
  endpoint: async () => {
    connects++
    throw Error("Must never connect during discovery")
  },
}
const create = (
  name: string,
  definitions: LocalBrowser[],
  defaultPath = path
) =>
  new BrowserService(definitions, {
    preferencePath: join(root, name),
    defaultApplication: async () => defaultPath,
  })
try {
  assert.equal(macApplicationBundle(path + "/Contents/MacOS/Browser"), path)
  assert.equal(
    macApplicationBundle("relative.app/Contents/MacOS/Browser"),
    undefined
  )
  assert.equal(macApplicationBundle("/usr/bin/node"), undefined)
  const single = create("single", [browser])
  assert.equal((await single.refresh()).find((b) => b.preferred)?.id, "unknown")
  await single.prefer(null)
  assert.equal(
    (await single.refresh()).some((b) => b.preferred),
    false,
    "Clearing choice survives refresh"
  )
  await single.close()
  const restarted = create("single", [browser])
  assert.equal(
    (await restarted.refresh()).some((b) => b.preferred),
    false,
    "Cleared choice survives host restart"
  )
  await restarted.close()
  for (const [name, profiles, defaultPath] of [
    ["ambiguous", [browser, { ...browser, id: "second" }], path],
    ["direct", [{ ...browser, transport: "direct" as const }], path],
    ["safari", [browser], "/Applications/Safari.app"],
    ["old", [{ ...browser, applicationPath: undefined }], path],
  ] as const) {
    const service = create(name, [...profiles], defaultPath)
    assert.equal(
      (await service.refresh()).some((b) => b.preferred),
      false,
      name
    )
    await service.close()
  }
  const chosen = create("chosen", [
    browser,
    { ...browser, id: "explicit", applicationPath: "/Applications/Other.app" },
  ])
  await chosen.prefer("explicit")
  assert.equal(
    (await chosen.refresh()).find((b) => b.preferred)?.id,
    "explicit"
  )
  await chosen.close()
  assert.equal(connects, 0)
  console.log(
    "PASS: generic OS-default extension choice; saved/cleared preferences persist; ambiguous, old, direct and non-default profiles never auto-select; no browser connection"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
