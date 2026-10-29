import "./lib/scratch-git.mjs"
/**
 * A project's carried files kept in Mako Cloud: the recipe's `carry` read from the main checkout, sent only with the
 * person's word for the project, each file only when it changed (by its hash) or the cloud holds another version, a
 * file the person kept here or the recipe dropped removed, and every name read without a value.
 */
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { promisify } from "node:util"
import { Git } from "@mako/git"
import { CloudCarriedFiles, variableNames, type CarriedFilesStore } from "@mako/host/workspaces/cloud-carried-files"
import type { z } from "zod"
import { RecipeSchema, readProjectRecipe, type ProjectRecipeRead } from "@mako/host/workspaces/thread-recipe"

/** A recipe's `carry` as an agent writes it: a path alone is copied. */
type Carry = z.input<typeof RecipeSchema>["carry"]
import type { CloudCarriedFile } from "@mako/host/contracts/cloud-carried-files"

const run = promisify(execFile)
const scratch = await mkdtemp(join(tmpdir(), "mako-carried-files-"))
after(() => rm(scratch, { recursive: true, force: true }))
const REPOSITORY = "https://github.com/acme/shop"
const git = new Git()
after(() => git.close())

/** The account's store in memory, as the gateway keeps it: a new version on every put, and every put counted. */
function memoryStore() {
  const files = new Map<string, CloudCarriedFile & { data: Buffer }>()
  const puts: string[] = []
  const store: CarriedFilesStore = {
    list: async (repository) => {
      assert.equal(repository, REPOSITORY)
      return [...files.values()].map(({ data: _data, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path))
    },
    put: async (_repository, file) => {
      puts.push(file.path)
      const saved = { path: file.path, version: crypto.randomUUID(), bytes: file.data.length, names: file.names, savedAt: new Date().toISOString(), data: file.data }
      files.set(file.path, saved)
      const { data: _data, ...listed } = saved
      return listed
    },
    remove: async (_repository, path) => {
      const removed = [...files.keys()].filter((each) => path === undefined || each === path).sort()
      for (const each of removed) files.delete(each)
      return removed
    },
  }
  return { store, files, puts }
}

async function project(carry: Carry) {
  const root = await mkdtemp(join(scratch, "shop-"))
  await run("git", ["-C", root, "init", "-q"])
  await writeFile(join(root, ".gitignore"), ".env\nconfig/local.json\nmodels/\nbig.bin\n")
  await writeFile(join(root, ".env"), "# the shop's keys\nexport SHOP_TOKEN=dummy-one\nDATABASE_URL = postgres://localhost/shop\n")
  await mkdir(join(root, "config"))
  await writeFile(join(root, "config", "local.json"), "{\"debug\":true}\n")
  await mkdir(join(root, "models"))
  await writeFile(join(root, "models", "weights.bin"), "w")
  await writeFile(join(root, "big.bin"), Buffer.alloc(256 * 1024 + 1))
  let recipe: ProjectRecipeRead = { kind: "recipe", recipe: RecipeSchema.parse({ carry }) }
  const { store, files, puts } = memoryStore()
  const carried = new CloudCarriedFiles({
    file: join(root, "..", `${crypto.randomUUID()}.json`),
    git,
    account: async () => ({ id: "u-1", store }),
    repositoryOf: async () => REPOSITORY,
    recipe: async () => recipe,
  })
  return {
    root, carried, files, puts,
    setRecipe: (next: Carry) => void (recipe = { kind: "recipe", recipe: RecipeSchema.parse({ carry: next }) }),
    /** The recipe as the main checkout has it now: none at all, or one Mako can't read. */
    setRead: (next: ProjectRecipeRead) => void (recipe = next),
  }
}

test("nothing leaves this Mac until the person says so for the project; then every file the recipe copies goes, once", async () => {
  const { root, carried, files, puts } = await project([".env", "config/local.json", { path: "models", link: true }, "big.bin"])
  const before = await carried.view(root)
  assert.equal(before.decision, "unasked")
  assert.deepEqual(before.files.map((file) => [file.path, file.credentials, file.cloud]), [[".env", true, null], ["config/local.json", false, null]])
  assert.deepEqual(before.staying.map((entry) => entry.path), ["models", "big.bin"])
  assert.deepEqual(await carried.sync(root, "a move"), { sent: [], removed: [], unchanged: 0 })
  assert.equal(files.size, 0)

  const allowed = await carried.decide(root, "allowed")
  assert.equal(allowed.decision, "allowed")
  assert.deepEqual(allowed.files.map((file) => file.cloud?.current), [true, true])
  assert.deepEqual(files.get(".env")?.names, ["DATABASE_URL", "SHOP_TOKEN"])
  assert.equal(files.get(".env")?.data.toString(), await readFile(join(root, ".env"), "utf8"))

  assert.deepEqual(await carried.sync(root, "a move"), { sent: [], removed: [], unchanged: 2 }, "nothing unchanged is sent again")
  assert.deepEqual(puts, [".env", "config/local.json"])
})

test("a changed file goes at the next sync, alone; one the cloud holds another version of goes again", async () => {
  const { root, carried, files, puts } = await project([".env", "config/local.json"])
  await carried.decide(root, "allowed")
  await writeFile(join(root, ".env"), "SHOP_TOKEN=dummy-two\n")
  assert.equal((await carried.view(root)).files.find((file) => file.path === ".env")?.cloud?.current, false, "the view says it changed here")
  assert.deepEqual(await carried.sync(root, "a move"), { sent: [".env"], removed: [], unchanged: 1 })
  assert.equal(files.get(".env")?.data.toString(), "SHOP_TOKEN=dummy-two\n")
  // Another Mac of the account sent its own.
  files.set("config/local.json", { ...files.get("config/local.json")!, version: crypto.randomUUID() })
  assert.deepEqual((await carried.sync(root, "a move")).sent, ["config/local.json"])
  assert.deepEqual(puts, [".env", "config/local.json", ".env", "config/local.json"])
})

test("a file the person removes stays on this Mac until they copy it again; one the recipe drops leaves the cloud", async () => {
  const { root, carried, files, setRecipe } = await project([".env", "config/local.json"])
  await carried.decide(root, "allowed")
  const kept = await carried.keep(root, ".env", true)
  assert.equal(kept.files.find((file) => file.path === ".env")?.kept, true)
  assert.equal(files.has(".env"), false)
  assert.deepEqual((await carried.sync(root, "a move")).sent, [], "a move doesn't put it back")
  await carried.keep(root, ".env", false)
  assert.equal(files.has(".env"), true)

  setRecipe([".env"])
  assert.deepEqual(await carried.sync(root, "a move"), { sent: [], removed: ["config/local.json"], unchanged: 1 })
  assert.deepEqual([...files.keys()], [".env"])
})

test("a recipe that can't be read removes nothing from the cloud and sends nothing; one that's gone carries nothing", async () => {
  const { root, carried, files, setRead } = await project([".env", "config/local.json"])
  await carried.decide(root, "allowed")
  setRead({ kind: "unreadable", why: "not JSON (Unexpected token)" })
  assert.deepEqual(await carried.sync(root, "a move"), { sent: [], removed: [], unchanged: 0 })
  assert.deepEqual([...files.keys()].sort(), [".env", "config/local.json"], "every file the cloud keeps stays")
  assert.match((await carried.view(root)).problem ?? "", /recipe can't be read \(not JSON/)
  setRead({ kind: "absent" })
  assert.deepEqual((await carried.sync(root, "a move")).removed, [".env", "config/local.json"])
})

test("the recipe as written reads as none, one, or one that can't be read: never an unreadable one as none", async () => {
  const root = await mkdtemp(join(scratch, "recipe-"))
  await run("git", ["-C", root, "init", "-q"])
  assert.deepEqual(await readProjectRecipe(git, root, undefined), { kind: "absent" })
  await mkdir(join(root, ".mako"), { recursive: true })
  await writeFile(join(root, ".mako", "recipe.json"), "{ \"carry\": [\".env\"], ")
  assert.equal((await readProjectRecipe(git, root, undefined)).kind, "unreadable", "not JSON")
  await writeFile(join(root, ".mako", "recipe.json"), JSON.stringify({ carry: "everything" }))
  assert.equal((await readProjectRecipe(git, root, undefined)).kind, "unreadable", "not a recipe")
  await writeFile(join(root, ".mako", "recipe.json"), JSON.stringify({ carry: [".env"] }))
  const read = await readProjectRecipe(git, root, undefined)
  assert.deepEqual(read.kind === "recipe" && read.recipe.carry, [{ path: ".env", link: false }])
})

test("the person's no removes everything of the project from the cloud, and sends nothing after", async () => {
  const { root, carried, files } = await project([".env", "config/local.json"])
  await carried.decide(root, "allowed")
  const declined = await carried.decide(root, "declined")
  assert.equal(declined.decision, "declined")
  assert.equal(files.size, 0)
  await writeFile(join(root, ".env"), "SHOP_TOKEN=dummy-three\n")
  assert.deepEqual(await carried.sync(root, "a move"), { sent: [], removed: [], unchanged: 0 })
})

test("a worktree's sync reads its main checkout's files", async () => {
  const { root, carried, files } = await project([".env"])
  await run("git", ["-C", root, "-c", "user.email=a@b.c", "-c", "user.name=A", "commit", "-q", "--allow-empty", "-m", "first"])
  const worktree = join(scratch, `worktree-${crypto.randomUUID()}`)
  await run("git", ["-C", root, "worktree", "add", "-q", "-b", "thread", worktree])
  await carried.decide(worktree, "allowed")
  assert.equal(files.get(".env")?.data.toString(), await readFile(join(root, ".env"), "utf8"))
})

test("an env file's variables are read by name, never a value; other files define none", () => {
  const text = "# comment\nexport A_KEY=secret-value\n  B = 2\nnot an assignment\nC=\n=nothing\n"
  assert.deepEqual(variableNames(".env.local", Buffer.from(text)), ["A_KEY", "B", "C"])
  assert.deepEqual(variableNames("config/.dev.vars", Buffer.from("TOKEN=x\n")), ["TOKEN"])
  assert.deepEqual(variableNames("config/local.json", Buffer.from("A=1\n")), [])
  assert.ok(!JSON.stringify(variableNames(".env", Buffer.from(text))).includes("secret-value"))
})
