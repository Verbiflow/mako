import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { environmentTools } from "../electron/environment-tools.js"
import { portListening, threadEnvironmentInstructions } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { publishDraft, recipePath, RecipeSchema, saveDraft, withLinkDefault } from "../electron/thread-recipe.js"
import { childHistory } from "../electron/watch-backend.js"
import { carryOutputs, carryReport, LINKED_MARK, linkedEntries, ownPackages } from "../electron/worktree-carry.js"
import { parse as parseYaml } from "yaml"

/**
 * A new checkout's packages linked to the main checkout's instead of
 * cloned: the links reach the main checkout's packages, its workspace
 * packages and `.bin` reach its own, caches stay its own, and no install
 * runs over the links, by Mako's own step or by an agent that asked first.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-package-links-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim()
const main = join(root, "shop")
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}
mkdirSync(main)
git(main, "init", "-q", "-b", "main")
write(join(main, ".gitignore"), "node_modules/\ndist/\n")
write(join(main, "package.json"), JSON.stringify({ name: "shop", workspaces: ["packages/*"] }))
write(join(main, "package-lock.json"), "{\"v\":1}\n")
write(join(main, "packages", "ui", "index.js"), "module.exports = 'main ui'\n")
write(join(main, "node_modules", "left-pad", "index.js"), "module.exports = 'left-pad'\n")
write(join(main, "node_modules", "left-pad", "cli.js"), "#!/usr/bin/env node\n")
write(join(main, "node_modules", "@scope", "tiny", "index.js"), "module.exports = 'tiny'\n")
write(join(main, "node_modules", ".vite", "deps.json"), "{}\n")
write(join(main, "node_modules", ".package-lock.json"), "{}\n")
symlinkSync("../../packages/ui", join(main, "node_modules", "@scope", "ui"))
mkdirSync(join(main, "node_modules", ".bin"))
symlinkSync("../left-pad/cli.js", join(main, "node_modules", ".bin", "left-pad"))
git(main, "add", "-A")
git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
const worktree = (name: string, ui: string) => {
  const path = join(root, name)
  git(main, "worktree", "add", "-q", "--detach", path)
  write(join(path, "packages", "ui", "index.js"), `module.exports = '${ui}'\n`)
  return path
}

const install = { command: "npm install", inputs: ["package-lock.json"], outputs: ["**/node_modules"], link: true }
try {
  // link is for any outputs; a step without outputs has nothing to link.
  assert.ok(RecipeSchema.safeParse({ prepare: [install] }).success)
  assert.ok(RecipeSchema.safeParse({ prepare: [{ ...install, outputs: ["**/node_modules", "dist"] }] }).success)
  assert.match(JSON.stringify(RecipeSchema.safeParse({ prepare: [{ command: "npm install", inputs: ["package-lock.json"], link: true }] }).error?.issues), /link is for a step's outputs/)
  // Saving fills in the default, so every stored version says; one that doesn't, written before the default, clones.
  const { link: _, ...unsaid } = install
  assert.equal(RecipeSchema.parse({ prepare: [unsaid] }).prepare[0]!.link, undefined, "a stored version without link keeps its meaning: cloned")
  assert.equal(withLinkDefault(RecipeSchema.parse({ prepare: [unsaid] })).prepare[0]!.link, true, "linking is the default a save writes out")
  assert.equal(withLinkDefault(RecipeSchema.parse({ prepare: [{ command: "cargo fetch", inputs: ["Cargo.lock"], outputs: ["target"] }] })).prepare[0]!.link, true, "for any outputs")
  assert.equal(withLinkDefault(RecipeSchema.parse({ prepare: [{ ...install, link: false }] })).prepare[0]!.link, false, "link: false clones them instead")
  assert.equal(withLinkDefault(RecipeSchema.parse({ prepare: [{ command: "make", inputs: ["Makefile"] }] })).prepare[0]!.link, undefined, "a step without outputs has nothing to link")
  const bare = RecipeSchema.parse({ prepare: [{ ...install, link: false }] })
  assert.equal(withLinkDefault(bare), bare, "nothing to fill in returns the recipe as it is")
  assert.match((await carryReport(RecipeSchema.parse({ prepare: [install] }), main)).join("\n"), /npm install: a new worktree's node_modules link each entry to the main checkout's when package-lock.json is the same there/)

  // Other outputs link entry by entry: what's made in the folder later stays the checkout's own.
  const built = worktree("built", "built ui")
  mkdirSync(join(main, "dist", "assets"), { recursive: true })
  writeFileSync(join(main, "dist", "index.html"), "<html></html>\n")
  const build = { command: "npm run build", inputs: ["package-lock.json"], outputs: ["dist"], link: true }
  assert.deepEqual((await carryOutputs(main, built, [build])).carried.map((entry) => entry.entries), [["dist"]])
  assert.equal(readlinkSync(join(built, "dist", "index.html")), join(main, "dist", "index.html"))
  assert.equal(readlinkSync(join(built, "dist", "assets")), join(main, "dist", "assets"))
  assert.deepEqual(await ownPackages(built, [build]), ["dist"], "app_own_packages makes any linked output the checkout's own")
  assert.ok(lstatSync(join(built, "dist", "index.html")).isFile())
  rmSync(join(main, "dist"), { recursive: true })

  // Linking: each package a link to the main checkout's, the rest this checkout's own.
  const fix = worktree("fix", "fix ui")
  const started = Date.now()
  const carried = await carryOutputs(main, fix, [install])
  assert.ok(Date.now() - started < 2_000)
  assert.deepEqual(carried.carried.map((entry) => entry.entries), [["node_modules"]])
  const modules = join(fix, "node_modules")
  assert.ok(lstatSync(modules).isDirectory() && !lstatSync(modules).isSymbolicLink(), "the folder is the checkout's own")
  assert.equal(readlinkSync(join(modules, "left-pad")), join(main, "node_modules", "left-pad"))
  assert.equal(readlinkSync(join(modules, "@scope", "tiny")), join(main, "node_modules", "@scope", "tiny"))
  assert.equal(readFileSync(join(modules, "@scope", "ui", "index.js"), "utf8"), "module.exports = 'fix ui'\n", "a workspace package is this checkout's own code")
  assert.equal(realpathSync(join(modules, ".bin", "left-pad")), realpathSync(join(main, "node_modules", "left-pad", "cli.js")))
  assert.equal(readlinkSync(join(modules, ".bin", "left-pad")), "../left-pad/cli.js")
  assert.equal(existsSync(join(modules, ".vite")), false, "caches stay each checkout's")
  assert.equal(existsSync(join(modules, ".package-lock.json")), false)
  assert.equal(execFileSync("node", ["-p", "require('left-pad') + ' ' + require('@scope/ui')"], { cwd: fix }).toString().trim(), "left-pad fix ui")
  assert.deepEqual(await linkedEntries(fix, [install]), ["node_modules"])
  assert.deepEqual(await linkedEntries(fix, [{ ...install, link: false }]), [], "only a linking step's folders count")

  // The agent is told, in its note and in app_status.
  const note = threadEnvironmentInstructions({ app: AppKeySchema.parse("folder-0123456789abcdef"), host: "fix.thread.localhost", port: 20_020, ports: 10, dataDir: join(root, "data"), recipe: { kind: "ready", processes: [], checks: [], linked: ["node_modules"] } })
  assert.match(note, /node_modules link each entry to the main checkout's/)
  assert.match(note, /call app_own_packages/)

  // Mako's own install step doesn't run over the links while the lockfile matches the main checkout's.
  const ran = join(root, "installs.log")
  const recipes = join(root, "recipes")
  const recipe = RecipeSchema.parse({
    prepare: [{ ...install, command: `test ! -e node_modules/${LINKED_MARK} && echo "$PWD" >> ${JSON.stringify(ran)}` }],
    checks: { quick: "node -e \"require('left-pad')\"" },
  })
  const environment = (dataDir: string): ThreadEnvironment => ({ app: AppKeySchema.parse("folder-00000000000000aa"), host: "fix.thread.localhost", port: 20_020, ports: 10, dataDir })
  const saved = await saveDraft(recipes, main, recipe, environment(join(root, "data")), {})
  await publishDraft(await recipePath(recipes, main), environment(join(root, "data")).app, saved.version.version, { at: Date.now(), on: "this Mac", checkout: main, steps: [] })
  const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
  const linking = recipe.prepare.map((step) => ({ ...step, link: true }))
  const tools = (checkout: string) => environmentTools({ cwd: () => checkout, environment: async () => environment(join(root, "data")), launchedWith: () => undefined, processes, recipesRoot: recipes, settleMs: 15_000 })
  const inFix = tools(fix)
  assert.match(await inFix.check("c1", "quick"), /passed/i)
  assert.equal(existsSync(ran), false, "no install ran over the links")
  assert.match(await inFix.status("c1"), /node_modules link each entry to the main checkout's\. Call app_own_packages/)
  assert.match(await inFix.status("c1"), /prepare:\n {2}.*: up to date\n/, "a linked checkout whose lockfile matches the main checkout's has nothing to install")

  // Asked first, the checkout gets its own copy and the main checkout's stays as it was.
  assert.match(await inFix.ownPackages("c1"), /node_modules is now this checkout's own/)
  assert.equal(existsSync(join(modules, LINKED_MARK)), false)
  assert.ok(lstatSync(join(modules, "left-pad")).isDirectory() && !lstatSync(join(modules, "left-pad")).isSymbolicLink())
  writeFileSync(join(modules, "left-pad", "index.js"), "module.exports = 'changed here'\n")
  assert.equal(readFileSync(join(main, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 'left-pad'\n", "a change in the copy stays out of the main checkout")
  assert.equal(readFileSync(join(modules, "@scope", "ui", "index.js"), "utf8"), "module.exports = 'fix ui'\n")
  assert.match(await inFix.ownPackages("c1"), /its own already/)
  assert.match(await inFix.status("c1"), /\npackages: This checkout's own/)

  // A changed lockfile: Mako makes the folder the checkout's own before its install step runs.
  const bump = worktree("bump", "bump ui")
  await carryOutputs(main, bump, linking)
  assert.deepEqual(await linkedEntries(bump, linking), ["node_modules"])
  writeFileSync(join(bump, "package-lock.json"), "{\"v\":2}\n")
  const inBump = tools(bump)
  assert.match(await inBump.check("c2", "quick"), /passed/i)
  assert.deepEqual(readFileSync(ran, "utf8").trim().split("\n"), [bump], "the install ran once, on the checkout's own copy")
  assert.deepEqual(await linkedEntries(bump, linking), [])
  assert.equal(readFileSync(join(main, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 'left-pad'\n")

  // The main checkout is never linked, and owning there changes nothing.
  assert.deepEqual(await ownPackages(main, linking), [])
  assert.equal(existsSync(join(main, "node_modules", LINKED_MARK)), false)

  // Proving a draft reads the file system's history under what the links reach in the main checkout:
  // an app that only runs its linked packages passes, one that writes through a link fails, naming the file.
  if (process.platform === "darwin") {
    const history = childHistory()
    const proving = worktree("prove", "prove ui")
    await carryOutputs(main, proving, linking)
    const provingEnvironment = { ...environment(join(root, "data-prove")), app: AppKeySchema.parse("folder-00000000000000bb") }
    mkdirSync(provingEnvironment.dataDir, { recursive: true })
    const inProve = environmentTools({ cwd: () => proving, environment: async () => provingEnvironment, launchedWith: () => undefined, processes, recipesRoot: recipes, settleMs: 15_000, history })
    const server = (write: boolean) => RecipeSchema.parse({
      ...recipe,
      processes: { web: {
        command: `node -e "require('left-pad'); require('@scope/ui'); ${write ? "require('fs').appendFileSync('node_modules/left-pad/index.js', '// written here\\n');" : ""} require('fs').writeFileSync(process.env.MAKO_THREAD_DATA_DIR + '/up', ''); setInterval(() => {}, 1e9)"`,
        ready: "test -f \"$MAKO_THREAD_DATA_DIR/up\"",
      } },
      verify: { run: "node -e \"require('left-pad')\"" },
    })
    await inProve.save("c3", server(false), "Only reads its packages")
    const clean = await inProve.publish("c3")
    assert.match(clean, /^Published version \d+ in [\d.]+ s: (install passed in [\d.]+ s, )?start passed in [\d.]+ s, verify passed in [\d.]+ s, links passed\./, "running and reading linked packages writes nothing through them")
    assert.deepEqual(await linkedEntries(proving, linking), ["node_modules"], "the proof ran on the links")
    await inProve.stop("c3")
    rmSync(join(provingEnvironment.dataDir, "up"), { force: true })
    await inProve.save("c3", server(true), "Writes into a package")
    const dirty = await inProve.publish("c3")
    assert.match(dirty, /while it was proven, node_modules\/left-pad\/index\.js changed in the main checkout \(.*\/shop\), inside what the recipe links, through this checkout's links or another worktree's\./, dirty)
    assert.match(dirty, /Set "link": false/)
    assert.match(parseYaml(await inProve.status("c3")).writesThroughLinks, /^Since this app came up, node_modules\/left-pad\/index\.js changed in the main checkout/, "app_status says so while the app runs")
    await inProve.stop("c3")
  }
  console.log("package links: linked in under 2 seconds with workspace packages, .bin and caches this checkout's own; the agent told; no install over the links; owned on request or before a changed lockfile's install, leaving the main checkout's packages as they were; any outputs link entry by entry; a proof that writes through the links fails, one that only runs them passes")
} finally {
  rmSync(root, { recursive: true, force: true })
}
