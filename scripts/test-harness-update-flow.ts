import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { CloudHarnesses } from "@mako/host/contracts/cloud-harnesses"
import type { HarnessVersions } from "@mako/host/contracts/harness-versions"
import { HarnessCheck } from "@mako/host/conversations/harness-check"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import type { ProviderUpdateSource } from "@mako/host/harnesses/update-source"

/**
 * The one step a Thread's chip offers when this Mac's harnesses are older than the cloud's: "Update Codex and
 * OpenCode, then move" (or "then bring it back"), run as the window runs it (`updateThen`) against the host's own
 * runtime readings and weighing (`RuntimeUpdates`, `HarnessCheck`), with only the updaters and the move faked.
 *
 * - The registry is down at the moment of the click, as it was beside two npm installs on production: the updates
 *   the chip offered run anyway, both, then the Thread moves, and nothing is left saying it's behind.
 * - An update that lands somewhere other than the binary Mako runs stops the step, names both, and the Thread stays.
 * - A harness updated in a terminal is weighed as it is now on "Check again", with no refresh of every reading first.
 */

const cloud: CloudHarnesses = { image: "mako-machine-fixture", revision: "0".repeat(40), harnesses: { codex: "0.164.0", opencode: "2.1.4" } }
const versions = (tested: string, feed: string): HarnessVersions => ({ tested, checked: { on: "2026-10-27", how: "fixture" }, feed: { npm: feed } })
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-update-flow-")))
const bin = join(root, "bin")
const nvm = join(root, "nvm", "versions", "node", "v24.19.0")
const codexBinary = join(nvm, "bin", "codex")
const opencodeBinary = join(root, "home", ".opencode", "bin", "opencode")
for (const [path, body] of [[join(bin, "npm"), ""], [codexBinary, ""], [opencodeBinary, ""]] as const) {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `#!/bin/sh\nexit 0\n${body}`, { mode: 0o755 })
}

/** One Mac: Codex from npm under nvm's node, OpenCode from its own installer, as production's was. */
function mac(options: { codexLands: "here" | "elsewhere" }) {
  const installed = new Map([[codexBinary, "0.159.3"], [opencodeBinary, "2.0.1"]])
  const changed = new Map([[codexBinary, 1], [opencodeBinary, 1]])
  const ran: string[] = []
  let registryDown = false
  const sources: ProviderUpdateSource[] = [
    { provider: "codex", binary: () => codexBinary, npmPackage: "@openai/codex", versions: versions("0.164.0", "@openai/codex"), install: [] },
    {
      provider: "opencode",
      binary: () => opencodeBinary,
      npmPackage: "@opencode/cli",
      versions: versions("2.1.4", "@opencode/cli"),
      native: { label: "Update", args: ["upgrade"], ownsPath: (path) => path.includes("/.opencode/bin/") },
      install: [],
    },
  ]
  const updates = new RuntimeUpdates({
    processes: new DiscoveryProcesses(),
    sources: () => sources,
    path: join(root, `readings-${Math.random().toString(36).slice(2)}.json`),
    env: () => ({ PATH: [bin, "/usr/bin", "/bin"].join(delimiter) }),
    emit: () => {},
    label: (provider) => ({ codex: "Codex", opencode: "OpenCode" })[provider] ?? provider,
    version: async (binary) => installed.get(binary) ?? "",
    stat: async (binary) => ({ mtimeMs: changed.get(binary) ?? 0, size: 1 }),
    realpath: async (path) => (path === codexBinary ? join(nvm, "lib", "node_modules", "@openai", "codex", "bin", "codex.js") : path),
    latest: async (_pkg, tag) => {
      if (registryDown) throw new Error("npm registry didn't answer within 4 s")
      return tag ?? "latest"
    },
    run: async (command, args) => {
      ran.push([command, ...args].join(" "))
      if (command === opencodeBinary) land(opencodeBinary, args.at(-1) ?? "")
      else if (options.codexLands === "here") land(codexBinary, (args.at(-1) ?? "").split("@").at(-1) ?? "")
      return { code: 0, output: "" }
    },
  })
  /** A new binary at `path`, as an installer leaves it. */
  function land(path: string, version: string) {
    installed.set(path, version)
    changed.set(path, (changed.get(path) ?? 0) + 1)
  }
  const check = new HarnessCheck({
    account: () => ({ cloudHarnesses: async () => cloud }),
    writers: () => null,
    installed: (harness) => updates.restoreRuntime(harness),
    reread: (harness) => updates.reread(harness),
    updates: () => updates.snapshot(),
    label: (harness) => ({ codex: "Codex", opencode: "OpenCode" })[harness] ?? harness,
  })
  const moved: string[] = []
  const back: string[] = []
  const bridge = {
    threadHarnessCheck: (_conversationId: string) => check.check([{ harness: "codex", path: "/codex/s1.jsonl" }, { harness: "opencode", path: "/opencode/s1" }]),
    runHarnessUpdate: (runtimeId: string) => updates.update(runtimeId),
    harnessUpdates: (refresh?: boolean) => updates.read(refresh === true),
    threadMove: async (conversationId: string) => {
      moved.push(conversationId)
      return { kind: "moved", cloudThread: "t-cloud" }
    },
    threadReturn: async (conversationId: string) => {
      back.push(conversationId)
      return { kind: "back" }
    },
  }
  return { updates, ran, moved, back, bridge, land, down: () => { registryDown = true } }
}

/** The window's bridge, as the preload hands it over: here, to one Mac's host at a time. */
const bridgeTo = (mako: ReturnType<typeof mac>["bridge"]) => Object.defineProperty(globalThis, "window", { value: { mako }, configurable: true, writable: true })
const { cloudMovesStore, updateThen, checkHarnesses } = await import("@/state/cloud-moves")
const behind = (conversationId: string) => {
  const check = cloudMovesStore.get().harnesses[conversationId]
  return check?.kind === "known" ? check.behind.map((each) => `${each.harness} ${each.here}`) : check
}

try {
  // Update both, then move; the registry is down by the time the person clicks.
  {
    const here = mac({ codexLands: "here" })
    bridgeTo(here.bridge)
    await here.updates.refresh()
    assert.deepEqual(await checkHarnesses("c1").then(() => behind("c1")), ["codex 0.159.3", "opencode 2.0.1"], "the chip offers both updates")
    here.down()
    await updateThen("c1", "move")
    assert.deepEqual(here.ran, [
      `${join(bin, "npm")} install -g --prefix ${nvm} --allow-scripts=@openai/codex @openai/codex@0.164.0`,
      `${opencodeBinary} upgrade 2.1.4`,
    ], "each offered update ran as offered: npm into the prefix Mako's Codex is under, OpenCode by its own upgrade")
    assert.equal(cloudMovesStore.get().updating.c1, undefined, "nothing left updating or failed")
    assert.deepEqual(behind("c1"), [], "weighed again after the updates: nothing behind")
    assert.deepEqual(here.moved, ["c1"], "then it moved")
    here.updates.stop()
  }

  // Update, then bring it back.
  {
    const here = mac({ codexLands: "here" })
    bridgeTo(here.bridge)
    await here.updates.refresh()
    await updateThen("c2", "back")
    assert.equal(here.ran.length, 2)
    assert.deepEqual(behind("c2"), [])
    assert.deepEqual(here.back, ["c2"], "then it came back")
    assert.deepEqual(here.moved, [])
    here.updates.stop()
  }

  // npm installs into another tree: the step stops at Codex, names both, and the Thread stays where it is.
  {
    const here = mac({ codexLands: "elsewhere" })
    bridgeTo(here.bridge)
    await here.updates.refresh()
    await updateThen("c3", "move")
    assert.deepEqual(cloudMovesStore.get().updating.c3?.failed, {
      harness: "codex",
      reason: `npm installed Codex 0.164.0 into ${nvm}, but Mako runs ${codexBinary}, still 0.159.3.`,
    }, "the failure says where the update went and what Mako runs")
    assert.equal(here.ran.length, 1, "nothing after the failed update runs")
    assert.deepEqual(here.moved, [], "and the Thread stays")
    assert.equal(here.updates.snapshot().codex?.result?.outcome, "failed", "Settings shows the same failure")
    here.updates.stop()
  }

  // Updated in a terminal: "Check again" (or coming back to the window) weighs what's installed now.
  {
    const here = mac({ codexLands: "here" })
    bridgeTo(here.bridge)
    await here.updates.refresh()
    assert.deepEqual(await checkHarnesses("c4").then(() => behind("c4")), ["codex 0.159.3", "opencode 2.0.1"])
    here.land(codexBinary, "0.164.0")
    assert.deepEqual(await checkHarnesses("c4").then(() => behind("c4")), ["opencode 2.0.1"], "Codex, updated a moment ago, isn't behind")
    here.updates.stop()
  }
} finally {
  Reflect.deleteProperty(globalThis, "window")
  await rm(root, { recursive: true, force: true })
}

console.log("PASS: update then move or bring back runs every offered update as offered, weighs again and goes; an update that lands elsewhere stops it with both paths named; Check again weighs what's installed now")
