import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverInstalledChromium,
  mergeInstalledBrowsers,
} from "../electron/browser-installed.js"
import { BrowserService } from "../electron/browser-service.js"
import { BrowserCommandSchema } from "../electron/contracts/browser-control.js"

const root = await mkdtemp(join(tmpdir(), "mako-browser-installed-"))
async function app(
  name: string,
  options: { https?: boolean; electron?: boolean } = {}
) {
  const path = join(root, `${name}.app`)
  const resources = join(
    path,
    "Contents",
    "Frameworks",
    `${name} Framework.framework`,
    "Versions",
    "Current",
    "Resources"
  )
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, "chrome_100_percent.pak"), "fixture")
  await writeFile(join(resources, "icudtl.dat"), "fixture")
  const info = {
    CFBundleDisplayName: name,
    CFBundleURLTypes: [
      {
        CFBundleURLSchemes:
          options.https === false ? ["custom"] : ["https", "http"],
      },
    ],
    ElectronAsarIntegrity: options.electron
      ? { "Resources/app.asar": { algorithm: "SHA256" } }
      : undefined,
  }
  await writeFile(join(path, "Contents", "Info.plist"), JSON.stringify(info))
  return realpath(path)
}
try {
  const chrome = await app("Google Chrome")
  const unknown = await app("Unlisted Chromium")
  await app("Mako", { electron: true })
  await app("Electron with renamed framework", { electron: true })
  await app("Not a web browser", { https: false })
  await symlink(chrome, join(root, "Alias.app"))
  const installed = await discoverInstalledChromium([root])
  assert.deepEqual(
    installed.map((b) => b.name),
    ["Google Chrome", "Unlisted Chromium"]
  )
  assert.ok(
    installed.every((b) => b.setupRequired && b.transport === "extension")
  )
  const definition = installed.find((b) => b.applicationPath === unknown)!
  let connects = 0
  const live = {
    ...definition,
    id: "live-profile",
    profileName: "Work",
    setupRequired: undefined,
    endpoint: async () => {
      connects++
      throw Error("No connection allowed")
    },
  }
  let catalog = installed
  const service = new BrowserService(() => catalog, {
    preferencePath: join(root, "preference.json"),
  })
  await service.prefer(definition.id)
  assert.equal(
    service.status().find((b) => b.preferred)?.connection.status,
    "setup-required"
  )
  assert.throws(() => service.connect(definition.id), /Mako Browser extension/)
  catalog = mergeInstalledBrowsers(installed, [live])
  assert.equal(catalog.filter((b) => b.applicationPath === unknown).length, 1)
  assert.equal((await service.refresh()).find((b) => b.preferred)?.id, live.id)
  assert.equal(
    connects,
    0,
    "Discovery and preference reconciliation never connect"
  )
  await service.close()
  const restarted = new BrowserService(catalog, {
    preferencePath: join(root, "preference.json"),
  })
  assert.equal(
    (await restarted.refresh()).find((b) => b.preferred)?.id,
    live.id
  )
  await restarted.close()
  const closed = new BrowserService(installed, {
    preferencePath: join(root, "preference.json"),
  })
  const closedStatuses = await closed.refresh()
  assert.equal(
    closedStatuses.filter((b) => b.applicationPath === unknown).length,
    1,
    "Closed saved profile does not duplicate its installed browser"
  )
  assert.equal(closedStatuses.find((b) => b.preferred)?.profileName, "Work")
  await closed.close()
  const ambiguous = new BrowserService(() => catalog, {
    preferencePath: join(root, "ambiguous.json"),
  })
  catalog = installed
  await ambiguous.prefer(definition.id)
  catalog = mergeInstalledBrowsers(installed, [
    live,
    { ...live, id: "personal" },
  ])
  assert.equal(
    (await ambiguous.refresh()).find((b) => b.preferred)?.id,
    definition.id
  )
  await ambiguous.close()
  const withIcon = new BrowserService([
    { ...definition, icon: "data:image/png;base64,fixture" },
  ])
  assert.equal(withIcon.status()[0]?.icon, "data:image/png;base64,fixture")
  const agentStatus = await withIcon.execute(
    "test",
    BrowserCommandSchema.parse({ action: "status" }),
    AbortSignal.timeout(5000)
  )
  assert.equal(
    JSON.stringify(agentStatus).includes("base64"),
    false,
    "Icons never enter agent context"
  )
  await withIcon.close()
  console.log(
    "PASS: unconnected installed Chromium; unknown brand; Electron exclusion; deduplication; exact preference migration; ambiguous profiles refuse; icons stay out of agent output"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
