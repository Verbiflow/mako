import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { mock } from "node:test"
import { cliListingCache } from "../electron/mcp-cli-cache.js"
import { discoverMcpRegistry } from "../electron/mcp-registry.js"
import { providerHost } from "../electron/providers/index.js"
import type { ProviderMcpSource } from "../electron/providers/mcp-source.js"

const root = await mkdtemp(join(tmpdir(), "mako-mcp-cli-cache-"))
try {
  await rules()
  await throughDiscovery()
  console.log(
    "MCP CLI listings: reused until an input or the CLI changes, shared while in flight, failures not kept, refreshed in the background when old"
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
  providerHost.mcpSources.register(source)
  const listing = mock.method(providerHost.mcpSources, "list", () => [source])
  const previousPath = process.env.PATH
  process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`
  const runs = async () => (await readFile(count, "utf8")).split("\n").filter(Boolean).length
  const names = async () => (await discoverMcpRegistry(root)).servers.map((server) => server.name)
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
    listing.mock.restore()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
}
