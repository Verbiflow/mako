import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { appRootOf, hostEnvironment, resolveHostEnvironment } from "../electron/host-environment.ts"

const root = await mkdtemp(join(tmpdir(), "mako-environment-"))
const home = join(root, "home")
const support = join(home, "Library", "Application Support")
try {
  const checkout = join(root, "checkout")
  await mkdir(checkout)
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "mako", version: "0.0.1" }))
  const bundle = join(root, "Mako.app", "Contents", "Resources", "app.asar")
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, "package.json"), JSON.stringify({ name: "mako", productName: "Mako", version: "1.4.0" }))
  const mac = (appRoot: string, env: NodeJS.ProcessEnv = {}) => resolveHostEnvironment({ env, appRoot, platform: "darwin", home })

  assert.deepEqual(mac(checkout), {
    dataRoot: join(support, "mako-dev"),
    defaultDataRoot: join(support, "mako"),
    appData: support,
    appRoot: checkout,
    appName: "mako",
    version: "0.0.1",
    packaged: false,
    development: true,
    profile: "dev",
    userRoot: join(home, ".mako"),
  }, "A checkout's host keeps the dev profile beside the installed app's data")
  assert.equal(mac(checkout, { MAKO_DATA_ROOT: join(root, "isolated") }).userRoot, join(root, "isolated"), "A host isolated outside appData keeps user state in its own root")
  assert.equal(mac(checkout, { MAKO_DATA_ROOT: join(support, "Mako-review") }).userRoot, join(home, ".mako"), "A launcher's profile root still shares the user's state")
  assert.equal(mac(checkout, { MAKO_PROD: "1" }).dataRoot, join(support, "mako"), "MAKO_PROD runs a checkout as the installed app")
  assert.equal(mac(checkout, { MAKO_PROD: "1" }).development, false)
  assert.equal(mac(checkout, { MAKO_PROFILE: "second" }).dataRoot, join(support, "mako-second"), "A named profile gets its own data root")
  assert.equal(mac(checkout, { MAKO_DATA_ROOT: "relative/data", MAKO_PROFILE: "second" }).dataRoot, resolve("relative/data"), "A launcher's data root wins, made absolute")
  assert.throws(() => mac(checkout, { MAKO_PROFILE: "../escape" }), /profile name/, "A profile name can't leave the data folder")

  const installed = mac(bundle)
  assert.equal(installed.packaged, true, "Contents/Resources/app.asar is an installed bundle")
  assert.equal(installed.profile, "", "The installed app uses its own data")
  assert.equal(installed.dataRoot, join(support, "Mako"), "Electron names the folder after productName")
  assert.equal(installed.appName, "Mako", "and the app, whose safeStorage keychain item is named after it")
  assert.equal(installed.version, "1.4.0")

  const linux = resolveHostEnvironment({ env: { XDG_CONFIG_HOME: "/config" }, appRoot: checkout, platform: "linux", home })
  assert.equal(linux.appData, "/config", "Linux keeps data under XDG_CONFIG_HOME")
  assert.equal(resolveHostEnvironment({ env: {}, appRoot: checkout, platform: "linux", home }).appData, join(home, ".config"))

  await mkdir(join(checkout, "dist-electron", "chunks"), { recursive: true })
  assert.equal(appRootOf(join(checkout, "dist-electron")), checkout, "The built host finds the checkout above it")
  assert.equal(appRootOf(join(checkout, "dist-electron", "chunks")), checkout, "A module at any depth finds the same app")
  assert.equal(appRootOf(checkout), checkout, "A bundle beside its package.json is its own app")
  assert.equal(appRootOf(join(bundle, "dist-electron")), bundle, "The installed host finds its app.asar")
  assert.throws(() => appRootOf(join(root, "home")), /No package.json/)

  const own = hostEnvironment()
  assert.equal(own.appRoot, resolve(import.meta.dirname, ".."), "This process's app root is the checkout")
  assert.equal(own.version, JSON.parse(await readFile(join(own.appRoot, "package.json"), "utf8")).version)
  assert.ok(Object.isFrozen(own), "The process's environment can't change once resolved")
  console.log("Host environment: checkout, MAKO_PROD, profiles, launcher data roots, bundles and Linux resolve without Electron")
} finally {
  await rm(root, { recursive: true, force: true })
}
