import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * What the host's production install carries that no process ever loads,
 * taken out of it in the image's own layer: type declarations and their maps,
 * source maps (the host runs without --enable-source-maps), TypeScript sources
 * (Node refuses to strip types under node_modules, so none of them can run;
 * the workspace packages carry only what they compiled) and incremental build
 * info. Everything that can execute stays, licences and
 * notices with it. Walks real folders only: the workspace links under
 * node_modules/@mako lead into packages/, which is walked once as itself.
 *
 * Then the packages in `UNLOADED`, where the install has them: each is
 * installed only for an entry point of its dependent that nothing here
 * imports. Each goes only while that stays so: no other package in the
 * install depends on it, none of the install's programs reaches it by any
 * import esbuild can follow, and its dependent still loads and works, by a
 * check of its own; otherwise this fails, and the image with it.
 *
 *   node prune-install.mjs <install root>
 */
const [root] = process.argv.slice(2)
assert.ok(root, "Pass the install root, the folder holding node_modules")
/** TypeScript (declarations included), a script's, stylesheet's or declaration's source map, and build info: never a data file that happens to end in `.map`. */
const unused = /\.(?:[cm]?ts|(?:[cm]?js|css|d\.[cm]?ts)\.map|tsbuildinfo)$/
let files = 0
let bytes = 0

function prune(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) prune(path)
    else if (entry.isFile() && unused.test(entry.name)) {
      bytes += lstatSync(path).size
      rmSync(path)
      files++
    }
  }
}

for (const folder of ["node_modules", "packages"]) if (existsSync(resolve(root, folder))) prune(resolve(root, folder))
console.log(`prune-install: removed ${files} files, ${(bytes / 2 ** 20).toFixed(1)} MB, that nothing loads`)

/**
 * `packages`, installed for `dependent` alone, which loads them only from entry points the host never imports.
 * `check` runs as an ES module from `from`, where the host imports `dependent`, and must exit 0 with them gone.
 */
const UNLOADED = [
  {
    // 68 MB. OpenCode's client depends on its schema and protocol packages and asks for Effect for its `effect` and
    // `solid` entry points; the host imports its promise client (`@opencode/client`), which reaches none of them.
    dependent: "@opencode/client",
    packages: ["effect", "@opencode/schema", "@opencode/protocol"],
    from: "packages/host",
    // The client as `harnesses/opencode/native-api.ts` makes it, asked once against a port nothing listens on: its
    // transport's error, not a module that's missing.
    check: `
      const { OpenCode, ClientError } = await import("@opencode/client")
      const client = OpenCode.make({ baseUrl: "http://127.0.0.1:9", headers: { Authorization: "Basic check" } })
      const failure = await client.session.active().then(() => undefined, (error) => error)
      if (!(failure instanceof ClientError)) throw failure ?? new Error("a closed port answered")
    `,
  },
  {
    // 5 MB once typings go. The Agent SDK names Anthropic's API SDK as a peer for its types; its own code is bundled
    // (`sdk.mjs`) and imports none of it, nor the schema typings that SDK depends on.
    dependent: "@anthropic-ai/claude-agent-sdk",
    packages: ["@anthropic-ai/sdk", "json-schema-to-ts", "@babel/runtime", "ts-algebra"],
    from: "packages/host",
    check: `
      const sdk = await import("@anthropic-ai/claude-agent-sdk")
      for (const name of ["query", "tool", "createSdkMcpServer"]) if (typeof sdk[name] !== "function") throw new Error(name + " is missing")
    `,
  },
]

const folderOf = (name) => resolve(root, "node_modules", name)
const present = UNLOADED.filter(({ dependent }) => existsSync(folderOf(dependent)))
if (present.length) {
  const dropping = new Set(present.flatMap(({ packages }) => packages).filter((name) => existsSync(folderOf(name))))
  const dependents = new Set(present.map(({ dependent }) => dependent))
  // No package but each one's own dependent (or another being dropped) depends on it.
  for (const manifest of manifests(resolve(root, "node_modules"))) {
    const { name, dependencies = {}, optionalDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8"))
    if (dropping.has(name) || dependents.has(name)) continue
    const needs = Object.keys({ ...dependencies, ...optionalDependencies }).filter((each) => dropping.has(each))
    assert.deepEqual(needs, [], `${name} depends on ${needs.join(", ")}, which prune-install.mjs drops as never loaded`)
  }
  // None of the install's programs reaches one, by any import esbuild can follow (dynamic ones with a literal included).
  const programs = []
  const programsIn = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) programsIn(path)
      else if (/^(?:mako-host|.*-main|.*worker)\.m?js$/.test(entry.name)) programs.push(path)
    }
  }
  for (const workspace of readdirSync(resolve(root, "packages"))) if (existsSync(resolve(root, "packages", workspace, "dist"))) programsIn(resolve(root, "packages", workspace, "dist"))
  const { build } = await import(resolve(root, "node_modules/esbuild/lib/main.js"))
  const traced = await build({ entryPoints: programs, bundle: true, splitting: true, platform: "node", format: "esm", outdir: "/unused", write: false, metafile: true, logLevel: "silent", external: ["electron", "original-fs"], loader: { ".node": "empty" } })
  const reached = Object.keys(traced.metafile.inputs).filter((file) => [...dropping].some((name) => file.includes(`node_modules/${name}/`)))
  assert.deepEqual(reached, [], `The host's programs (${programs.length}) reach what prune-install.mjs drops as never loaded`)
  let dropped = 0
  for (const name of dropping) {
    dropped += sizeOf(folderOf(name))
    rmSync(folderOf(name), { recursive: true })
  }
  for (const { dependent, from, check } of present) {
    const ran = spawnSync(process.execPath, ["--input-type=module", "-e", check], { cwd: resolve(root, from), encoding: "utf8", timeout: 60_000 })
    assert.equal(ran.status, 0, `${dependent} doesn't work without what prune-install.mjs dropped:\n${ran.stderr}`)
  }
  console.log(`prune-install: dropped ${[...dropping].join(", ")}, ${(dropped / 2 ** 20).toFixed(1)} MB, that nothing here loads; ${[...dependents].join(", ")} still works`)
}

/** Every installed package's manifest, scoped ones and nested node_modules included. */
function manifests(folder) {
  const found = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const path = join(folder, entry.name)
    if (entry.name.startsWith("@")) {
      found.push(...manifests(path))
      continue
    }
    if (existsSync(join(path, "package.json"))) found.push(join(path, "package.json"))
    if (existsSync(join(path, "node_modules"))) found.push(...manifests(join(path, "node_modules")))
  }
  return found
}

function sizeOf(path) {
  const info = lstatSync(path)
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0)
}
