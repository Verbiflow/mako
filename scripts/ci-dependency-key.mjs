import { createHash } from "node:crypto"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * The hash the installed tree is cached under (`.github/actions/install-dependencies`): everything `npm ci` installs
 * from and checks, and nothing else. The lockfile and the patches its postinstall applies, whole; of each package.json
 * (the root's and every workspace's), only what decides the tree: its name, version, dependency fields, overrides,
 * workspaces and the lifecycle scripts `npm ci` runs; and any `.npmrc`. A dependency changed without the lockfile
 * still misses, so `npm ci` refuses it as a cold install would, while an edit to any other script, which most pull
 * requests make, keeps the cache.
 *
 *   node scripts/ci-dependency-key.mjs     prints the hash
 */
const FIELDS = ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "overrides", "workspaces", "engines", "os", "cpu"]
/** The lifecycle scripts `npm ci` runs as it installs, which can change the tree it leaves. */
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish"]
const manifests = ["package.json", ...readdirSync("packages").map((name) => join("packages", name, "package.json")).filter((path) => existsSync(path))].sort()
const patches = readdirSync("scripts").filter((name) => /^patch-.*\.mjs$/.test(name)).sort().map((name) => join("scripts", name))

const hash = createHash("sha256")
hash.update(readFileSync("package-lock.json"))
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8"))
  const lifecycle = Object.fromEntries(LIFECYCLE.filter((name) => manifest.scripts?.[name] !== undefined).map((name) => [name, manifest.scripts[name]]))
  hash.update(`\0${path}\0${JSON.stringify({ ...Object.fromEntries(FIELDS.filter((field) => field in manifest).map((field) => [field, manifest[field]])), lifecycle })}`)
}
for (const path of patches) hash.update(`\0${path}\0`).update(readFileSync(path))
// npm's own configuration where it installs: the registry, scripts or engines it reads change what it installs.
for (const path of [".npmrc", ...readdirSync("packages").map((name) => join("packages", name, ".npmrc"))].filter((each) => existsSync(each)).sort())
  hash.update(`\0${path}\0`).update(readFileSync(path))
console.log(hash.digest("hex"))
