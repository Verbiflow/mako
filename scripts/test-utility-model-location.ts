import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  legacyUtilityModelDirectory,
  migrateUtilityModels,
  utilityModelDirectory,
} from "../electron/utility-model-location.ts"
import {
  UtilityModelStore,
  type UtilityKeyEncryption,
} from "../electron/utility-model-store.ts"

const root = await mkdtemp(join(tmpdir(), "mako-utility-model-location-"))
const home = join(root, "home")
const shared = join(home, ".mako", "utility-models")

// Where connections live.
assert.equal(
  utilityModelDirectory({ dataRoot: join(root, "mako-dev"), env: {}, home }),
  shared,
  "a profile host reads the user's connections"
)
assert.equal(
  utilityModelDirectory({ dataRoot: join(root, "mako"), env: {}, home }),
  shared,
  "the default profile reads the same store"
)
assert.equal(
  utilityModelDirectory({
    dataRoot: join(root, "fixture"),
    env: { MAKO_DATA_ROOT: join(root, "fixture") },
    home,
  }),
  join(root, "fixture", "utility-models"),
  "an isolated data root keeps its connections to itself"
)
assert.equal(legacyUtilityModelDirectory(join(root, "mako-dev")), join(root, "mako-dev", "utility-models"))

async function profile(name: string, files: Record<string, { text: string; age: number }>) {
  const directory = legacyUtilityModelDirectory(join(root, name))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [file, { text, age }] of Object.entries(files)) {
    const path = join(directory, file)
    await writeFile(path, text, { mode: 0o600 })
    const when = new Date(Date.now() - age * 1000)
    await utimes(path, when, when)
  }
  return directory
}

// A store that does not exist yet receives the profile's files.
const first = await profile("mako", {
  "google.enc": { text: "google@mako", age: 300 },
  "openai.enc": { text: "openai@mako", age: 300 },
  "notes.txt": { text: "not a connection", age: 300 },
  "unknown.enc": { text: "no such provider", age: 300 },
})
assert.deepEqual(await migrateUtilityModels(first, shared), {
  moved: ["google", "openai"],
  replaced: [],
  dropped: [],
})
assert.equal(await readFile(join(shared, "google.enc"), "utf8"), "google@mako")
assert.equal((await stat(join(shared, "google.enc"))).mode & 0o777, 0o600)
assert.equal((await stat(join(home, ".mako", "utility-models"))).mode & 0o777, 0o700)
assert.deepEqual((await readdir(first)).sort(), ["notes.txt", "unknown.enc"], "only provider files move")

// A newer profile copy replaces the shared one; an older copy is dropped.
const second = await profile("mako-dev", {
  "google.enc": { text: "google@dev", age: 10 },
  "openai.enc": { text: "openai@dev", age: 900 },
})
assert.deepEqual(await migrateUtilityModels(second, shared), {
  moved: [],
  replaced: ["google"],
  dropped: ["openai"],
})
assert.equal(await readFile(join(shared, "google.enc"), "utf8"), "google@dev")
assert.equal(await readFile(join(shared, "openai.enc"), "utf8"), "openai@mako")
await assert.rejects(stat(second), /ENOENT/, "an emptied profile directory is removed")

// The move keeps the file's own time, so the order hosts start in does not decide.
const googleTime = (await stat(join(shared, "google.enc"))).mtimeMs
assert.ok(Date.now() - googleTime > 5_000 && Date.now() - googleTime < 60_000)

// Nothing to do: no legacy directory, or the store is the legacy directory.
assert.deepEqual(await migrateUtilityModels(join(root, "never"), shared), { moved: [], replaced: [], dropped: [] })
assert.deepEqual(await migrateUtilityModels(shared, shared), { moved: [], replaced: [], dropped: [] })
assert.equal(await readFile(join(shared, "google.enc"), "utf8"), "google@dev")

// The store waits for the migration before its first read.
const encryption: UtilityKeyEncryption = {
  available: () => true,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
}
const record = JSON.stringify({
  provider: "google",
  model: "gemini-test",
  contextTokens: 32_000,
  apiKey: "synthetic-key",
})
const third = await profile("mako-review", { "google.enc": { text: record, age: 1 } })
let release: () => void = () => undefined
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const store = new UtilityModelStore(shared, encryption, {
  ready: gate.then(() => migrateUtilityModels(third, shared)),
})
const pending = store.settings()
let settled = false
void pending.then(() => {
  settled = true
})
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(settled, false, "reads wait for the migration")
release()
const settings = await pending
assert.deepEqual(
  settings.connections.map((connection) => connection.model),
  ["gemini-test"]
)
assert.doesNotMatch(JSON.stringify(settings), /synthetic-key/)

await rm(root, { recursive: true, force: true })
console.log("utility model location ok")
