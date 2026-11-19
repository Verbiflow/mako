import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { commonDirOf } from "@mako/git"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { cliListingCache } from "@mako/host/tools/mcp-cli-cache"
import { mcpListingsPath, mcpListingStore } from "@mako/host/tools/mcp-listing-store"
import { mcpRegistry } from "@mako/host/tools/mcp-registry"
import { toolHarnesses } from "@mako/host/harnesses/tool-harnesses"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { ProviderMcpSource } from "@mako/host/tools/mcp-source"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

const root = await mkdtemp(join(tmpdir(), "mako-mcp-cli-cache-"))
try {
  await rules()
  await waitsForIdle()
  await throughDiscovery()
  await keptBetweenHosts()
  await startWaitsForItsOwnHarness()
  console.log(
    "MCP CLI listings: reused until an input or the CLI changes, shared while in flight, failures not kept, refreshed in the background when old, once no start waits; kept on disk between hosts with their stamps, in a file other builds share; a start has another harness's servers as kept for its folder or for a sibling worktree that reads the same, and waits for that CLI only with neither"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

async function rules() {
  let clock = 0
  const cache = cliListingCache<string>({ refreshAfterMs: 1_000, limit: 2, now: () => clock })
  const config = join(root, "config.toml")
  await writeFile(config, "one")
  let runs = 0
  const list = async () => `listing ${++runs}`

  const together = await Promise.all([1, 2, 3].map(() => cache.read("a", [config], list)))
  assert.deepEqual(together, ["listing 1", "listing 1", "listing 1"], "Concurrent asks share one run")
  assert.equal(await cache.read("a", [config], list), "listing 1", "An unchanged input reuses the listing")
  assert.equal(runs, 1)

  await writeFile(config, "two")
  assert.equal(await cache.read("a", [config], list), "listing 2", "A changed input runs the CLI before answering")

  const created = join(root, "project.toml")
  assert.equal(await cache.read("a", [config, created], list), "listing 3", "A newly declared input is a change")
  assert.equal(await cache.read("a", [config, created], list), "listing 3")
  await writeFile(created, "")
  assert.equal(await cache.read("a", [config, created], list), "listing 4", "Creating a missing input is a change")

  let failing = true
  const flaky = async () => {
    if (failing) throw new Error("timed out")
    return "recovered"
  }
  await assert.rejects(cache.read("b", [config], flaky), /timed out/)
  failing = false
  assert.equal(await cache.read("b", [config], flaky), "recovered", "A failed run is not kept")

  clock = 5_000
  runs = 10
  assert.equal(await cache.read("a", [config, created], list), "listing 4", "An old listing is still served")
  await new Promise((done) => setImmediate(done))
  assert.equal(runs, 11, "Serving an old listing starts one background run")
  assert.equal(await cache.read("a", [config, created], list), "listing 11", "The background run's listing is served next")
  assert.equal(runs, 11)

  await cache.read("c", [config], list)
  await cache.read("b", [config], list)
  const before = runs
  await cache.read("a", [config, created], list)
  assert.equal(runs, before + 1, "The least recently read listing goes first past the limit")
}

/** A start holds the host's foreground; a listing read again only for its age waits for it, and a change doesn't. */
async function waitsForIdle() {
  let clock = 0
  let release = () => {}
  let idle: Promise<void> = new Promise((resolve) => (release = resolve))
  const cache = cliListingCache<string>({ refreshAfterMs: 1_000, limit: 4, now: () => clock, idle: () => idle })
  const config = join(root, "idle.toml")
  await writeFile(config, "one")
  let runs = 0
  const list = async () => `listing ${++runs}`
  assert.equal(await cache.read("a", [config], list), "listing 1", "The first listing doesn't wait: a start needs it")
  clock = 5_000
  assert.equal(await cache.read("a", [config], list), "listing 1", "An old listing is served while a start holds the host")
  await new Promise((done) => setTimeout(done, 20))
  assert.equal(runs, 1, "Its background run waits for the start")
  release()
  await new Promise((done) => setTimeout(done, 20))
  assert.equal(runs, 2, "and runs once it's over")
  assert.equal(await cache.read("a", [config], list), "listing 2")

  idle = new Promise((resolve) => (release = resolve))
  clock = 10_000
  await cache.read("a", [config], list)
  await writeFile(config, "two")
  assert.equal(await cache.read("a", [config], list), "listing 3", "A changed input runs at once, start or not")
  release()
  await new Promise((done) => setTimeout(done, 20))
  assert.equal(runs, 3, "and the old listing's waiting run is dropped")
}

async function throughDiscovery() {
  const config = join(root, "fixture.json")
  const count = join(root, "runs.log")
  const cli = join(root, "fixture-cli")
  await writeFile(config, JSON.stringify({ mcpServers: { first: { url: "http://127.0.0.1:9/mcp" } } }))
  await writeFile(count, "")
  await writeFile(
    cli,
    `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs")
appendFileSync(${JSON.stringify(count)}, "run\\n")
process.stdout.write(readFileSync(${JSON.stringify(config)}, "utf8"))
`,
    { mode: 0o700 }
  )
  const source: ProviderMcpSource = {
    provider: "cli-cache-fixture",
    command: () => "fixture-cli",
    userFiles: () => [],
    workspaceFiles: () => [],
    cliList: { inputs: () => [config] },
    readFormat: "named-map-or-list",
    write: { kind: "none" },
  }
  const registry = mcpRegistry({ ...toolHarnesses(providerHost), mcpSources: { get: (provider) => provider === source.provider ? source : undefined, list: () => [source] } })
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
  const runs = async () => (await readFile(count, "utf8")).split("\n").filter(Boolean).length
  const names = async () => (await registry.discover(root)).servers.map((server) => server.name)
  try {
    assert.deepEqual(await names(), ["first"])
    assert.deepEqual(await names(), ["first"])
    assert.equal(await runs(), 1, "A second discovery with nothing changed does not run the CLI")
    await writeFile(config, JSON.stringify({ mcpServers: { second: { url: "http://127.0.0.1:9/mcp" } } }))
    assert.deepEqual(await names(), ["second"], "Editing the CLI's config shows on the next discovery")
    assert.equal(await runs(), 2)
    await writeFile(cli, `${await readFile(cli, "utf8")}// updated\n`)
    await names()
    assert.equal(await runs(), 3, "Updating the CLI runs it again")
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

/** A CLI that prints `config` as its listing and notes each run in `count`. */
async function fixtureCli(name: string, config: string, count: string): Promise<void> {
  await writeFile(count, "")
  await writeFile(join(root, name), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs")
appendFileSync(${JSON.stringify(count)}, "run\\n")
process.stdout.write(readFileSync(${JSON.stringify(config)}, "utf8"))
`, { mode: 0o700 })
}

function fixtureSource(provider: string, command: string, config: string): ProviderMcpSource {
  return { provider, command: () => command, userFiles: () => [], workspaceFiles: () => [], cliList: { inputs: () => [config] }, readFormat: "named-map-or-list", write: { kind: "none" } }
}

async function ranTimes(count: string): Promise<number> {
  return (await readFile(count, "utf8")).split("\n").filter(Boolean).length
}

/**
 * The listings outlive the host: a registry opened on the same user root answers a start from the file, with no CLI
 * run, while the stamp kept there still matches; a moved stamp runs the CLI as it would in memory. The file is one
 * every build on the root shares, so it keeps its version and whatever a newer build put in it.
 */
async function keptBetweenHosts() {
  const userRoot = join(root, "user-root")
  const config = join(root, "kept.json")
  const count = join(root, "kept-runs.log")
  await writeFile(config, JSON.stringify({ mcpServers: { kept: { url: "http://127.0.0.1:9/mcp" } } }))
  await fixtureCli("kept-cli", config, count)
  const source = fixtureSource("kept-fixture", "kept-cli", config)
  const harnesses = { ...toolHarnesses(providerHost), mcpSources: { get: (provider: string) => provider === source.provider ? source : undefined, list: () => [source] } }
  const open = () => mcpRegistry(harnesses, undefined, { listings: mcpListingsPath(userRoot) })
  const names = async (registry: ReturnType<typeof mcpRegistry>) => (await registry.discover(root, source.provider)).servers.map((server) => server.name)
  const file = mcpListingsPath(userRoot)
  const saved = async () => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      const text = await readFile(file, "utf8").catch(() => null)
      if (text) return JSON.parse(text)
      await new Promise((done) => setTimeout(done, 20))
    }
    throw new Error("the listing was never saved")
  }
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
  try {
    assert.deepEqual(await names(open()), ["kept"])
    assert.equal(await ranTimes(count), 1)
    const written = await saved()
    assert.equal(written.version, 1, "the file says its format")
    assert.equal((await stat(file)).mode & 0o777, 0o600, "and is the person's alone to read")
    assert.equal(Object.keys(written.listings).length, 1)

    // A host started after it: the same listing, from the file.
    assert.deepEqual(await names(open()), ["kept"], "a restarted registry answers a start from disk")
    assert.equal(await ranTimes(count), 1, "without running the CLI")

    // What a newer build wrote beside the listings, and in one, comes back out of this build's rewrite.
    const [key] = Object.keys(written.listings)
    written.future = { kept: true }
    written.listings[key!].future = "kept too"
    written.listings["a-newer-build's entry"] = { kept: "as this build can't read it" }
    await writeFile(file, JSON.stringify(written))
    await writeFile(config, JSON.stringify({ mcpServers: { moved: { url: "http://127.0.0.1:9/mcp" } } }))
    assert.deepEqual(await names(open()), ["moved"], "a stamp that moved since the file was written runs the CLI")
    assert.equal(await ranTimes(count), 2)
    let rewritten = await saved()
    for (let waited = 0; waited < 5_000 && !String(rewritten.listings[key!].listing).includes("moved"); waited += 20) {
      await new Promise((done) => setTimeout(done, 20))
      rewritten = await saved()
    }
    assert.ok(String(rewritten.listings[key!].listing).includes("moved"), "the new listing is saved")
    assert.deepEqual(rewritten.future, { kept: true }, "a field this build doesn't name is written back")
    assert.equal(rewritten.listings[key!].future, "kept too", "inside a listing too")
    assert.deepEqual(rewritten.listings["a-newer-build's entry"], { kept: "as this build can't read it" }, "as is an entry it can't read")

    // A newer build's format is its to rewrite: this one lists for itself and leaves the file.
    const newer = JSON.stringify({ version: 2, listings: {} })
    await writeFile(file, newer)
    assert.deepEqual(await names(open()), ["moved"])
    assert.equal(await ranTimes(count), 3, "nothing it can use in a newer format: the CLI runs")
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(await readFile(file, "utf8"), newer, "and the newer build's file is left as it was")

    // The store alone: a torn file starts over, and two hosts' listings merge, the newer of two for one key.
    await mkdir(userRoot, { recursive: true })
    await writeFile(file, "{torn")
    const store = mcpListingStore(file)
    assert.equal((await store.load()).size, 0)
    await store.save(new Map([["a", { stamp: "s1", listing: "one", listedAt: 1 }]]))
    await mcpListingStore(file).save(new Map([["a", { stamp: "s0", listing: "older", listedAt: 0 }], ["b", { stamp: "s2", listing: "two", listedAt: 2 }]]))
    assert.deepEqual([...(await store.load())].sort(), [["a", { stamp: "s1", listing: "one", listedAt: 1 }], ["b", { stamp: "s2", listing: "two", listedAt: 2 }]])
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

/**
 * A start reads its own harness's CLI as it is now, and never goes without another harness's servers. Another
 * harness's listing comes, in this order: as kept for this folder (even changed since, read again behind the start);
 * as kept for another worktree of the same repository whose project config reads the same; and with neither, by
 * waiting for its CLI as a start always did.
 */
async function startWaitsForItsOwnHarness() {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })
  const repo = join(root, "repository")
  await mkdir(repo)
  git(repo, "init", "-q")
  git(repo, "config", "user.name", "Test")
  git(repo, "config", "user.email", "test@localhost")
  // The other harness's project config, as each checkout carries it: an input of its listing in that folder alone.
  await writeFile(join(repo, "project.json"), "{}")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "initial")
  const worktree = join(root, "worktree-same"), changed = join(root, "worktree-changed"), elsewhere = join(root, "another-folder")
  git(repo, "worktree", "add", "-q", worktree)
  git(repo, "worktree", "add", "-q", changed)
  await writeFile(join(changed, "project.json"), JSON.stringify({ branch: "defines another server" }))
  await mkdir(elsewhere)
  const own = { config: join(root, "own.json"), count: join(root, "own-runs.log") }
  const other = { config: join(root, "other.json"), count: join(root, "other-runs.log") }
  await writeFile(own.config, JSON.stringify({ mcpServers: { mine: { url: "http://127.0.0.1:9/mine" } } }))
  await writeFile(other.config, JSON.stringify({ mcpServers: { theirs: { url: "http://127.0.0.1:9/theirs" } } }))
  await fixtureCli("own-cli", own.config, own.count)
  await fixtureCli("other-cli", other.config, other.count)
  const sources: ProviderMcpSource[] = [
    fixtureSource("own-fixture", "own-cli", own.config),
    { ...fixtureSource("other-fixture", "other-cli", other.config), cliList: { inputs: (_env, cwd) => [other.config, join(cwd, "project.json")] } },
  ]
  let release = () => {}
  let idle: Promise<void> = new Promise((resolve) => (release = resolve))
  const registry = mcpRegistry({ ...toolHarnesses(providerHost), mcpSources: { get: (provider) => sources.find((source) => source.provider === provider), list: () => sources } }, () => idle, { repository: commonDirOf })
  const names = async (cwd: string, starting?: string) => (await registry.discover(cwd, starting)).servers.map((server) => server.name).sort()
  const behind = async (ran: number) => {
    release()
    for (let waited = 0; waited < 5_000 && await ranTimes(other.count) < ran; waited += 20) await new Promise((done) => setTimeout(done, 20))
    await new Promise((done) => setTimeout(done, 100))
    idle = new Promise((resolve) => (release = resolve))
  }
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
  try {
    // Nothing kept for this folder or any other of its repository: the start waits for the other harness's CLI.
    assert.deepEqual(await names(repo, "own-fixture"), ["mine", "theirs"], "nothing kept: a start waits for the other harness's CLI rather than go without its servers")
    assert.deepEqual([await ranTimes(own.count), await ranTimes(other.count)], [1, 1])

    // Kept for this folder: served without a run, and when its config has changed, as last read, then read behind.
    assert.deepEqual(await names(repo, "own-fixture"), ["mine", "theirs"])
    assert.equal(await ranTimes(other.count), 1, "kept for this folder: no run")
    await writeFile(other.config, JSON.stringify({ mcpServers: { changed: { url: "http://127.0.0.1:9/changed" } } }))
    assert.deepEqual(await names(repo, "own-fixture"), ["mine", "theirs"], "kept for this folder but changed since: served as last read")
    assert.equal(await ranTimes(other.count), 1, "its run waits while a start holds the host")
    await behind(2)
    assert.equal(await ranTimes(other.count), 2, "and happens once behind it")
    assert.deepEqual(await names(repo, "own-fixture"), ["changed", "mine"], "the next start has the change")

    // Kept for a sibling worktree whose project config reads the same: that listing answers, and this folder's own is
    // read behind the start.
    assert.deepEqual(await names(worktree, "own-fixture"), ["changed", "mine"], "a new worktree has the other harness's servers from its sibling's listing")
    assert.deepEqual([await ranTimes(own.count), await ranTimes(other.count)], [2, 2], "having run only its own harness's CLI")
    await behind(3)
    assert.equal(await ranTimes(other.count), 3, "the worktree's own listing is read behind the start")
    assert.deepEqual(await names(worktree, "own-fixture"), ["changed", "mine"])
    assert.equal(await ranTimes(other.count), 3, "and kept from then on")

    // A sibling whose project config differs (another branch's) would list differently: its CLI is waited for.
    assert.deepEqual(await names(changed, "own-fixture"), ["changed", "mine"])
    assert.equal(await ranTimes(other.count), 4, "a worktree whose project config differs from every sibling's waits for the CLI")

    // A sibling's listing gone stale (its shared config changed since) answers for nobody: waited for again.
    await writeFile(other.config, JSON.stringify({ mcpServers: { newest: { url: "http://127.0.0.1:9/newest" } } }))
    const fresh = join(root, "worktree-fresh")
    git(repo, "worktree", "add", "-q", fresh)
    assert.deepEqual(await names(fresh, "own-fixture"), ["mine", "newest"], "no sibling's listing is current: the start waits and has the newest")
    assert.equal(await ranTimes(other.count), 5)

    // A folder of no repository, or of another, has no sibling: waited for.
    assert.deepEqual(await names(elsewhere, "own-fixture"), ["mine", "newest"])
    assert.equal(await ranTimes(other.count), 6, "a folder outside the repository waits for the CLI")

    // The other harness's own start, and a listing nobody starts on (Settings), read every CLI as it is now.
    await writeFile(other.config, JSON.stringify({ mcpServers: { again: { url: "http://127.0.0.1:9/again" } } }))
    assert.deepEqual(await names(repo, "other-fixture"), ["again", "mine"], "its own start waits for its change")
    await writeFile(own.config, JSON.stringify({ mcpServers: { settings: { url: "http://127.0.0.1:9/settings" } } }))
    assert.deepEqual(await names(repo), ["again", "settings"], "a listing for no start waits for all of them")
  } finally {
    release()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}
