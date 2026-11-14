/**
 * Setup beside the host: a place's own readings as rows (the recipe's carry, the cloud's carried files, sign-ins,
 * processes), and the host's `SetupViews` on a scratch checkout and on this device's brokers and the account's, each
 * answer and Stop going where its ask or grant is kept. The rows and words themselves are the protocol's
 * (`packages/protocol/test/setup.mjs`).
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Grant } from "@mako/protocol/borrow"
import {
  askLine,
  rowAction,
  syncWords,
  type SetupPlace,
  type SetupPlaceView,
  type SetupRow,
} from "@mako/host/contracts/setup"
import { carriedCloudRows, carryRows, cloudSignInRows, processRows } from "@mako/host/contracts/setup-readings"
import type { RecipeView } from "@mako/host/contracts/project-app"

const NOW = Date.UTC(2026, 10, 4, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ACCOUNT = "acct"
const REPO = "acme/shop"

const cloud: SetupPlace = { kind: "cloud" }

function grant(id: string, partial: Partial<Grant> & Pick<Grant, "resource" | "source" | "mode">): Grant {
  return {
    id,
    scope: { level: "project", account: ACCOUNT, repository: REPO },
    access: partial.resource.kind === "command" || partial.resource.kind === "port" ? "run" : "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    grantedBy: { kind: "person", account: ACCOUNT },
    grantedAt: NOW - 9 * DAY,
    version: 1,
    ...partial,
  }
}

const rows = (place: SetupPlaceView) => place.parts.flatMap((part) => part.rows)
const named = (place: SetupPlaceView, name: string): SetupRow => {
  const found = rows(place).find((row) => row.name === name)
  assert.ok(found, `${place.id} has ${name}: ${rows(place).map((row) => row.name).join(", ")}`)
  return found
}

test("the recipe's carry, the cloud's carried files and sign-ins read as rows", () => {
  const recipe: RecipeView = {
    values: {},
    processes: [{ name: "web", command: "npm run dev", port: "{port}" }],
    checks: {},
    prepare: [],
    carry: [
      { path: ".env.local", link: false, credentials: true },
      { path: "node_modules", link: true, credentials: false },
      { path: "config/missing.json", link: false, credentials: false },
    ],
    oneAtATime: false,
  }
  const carried = carryRows(recipe, new Map([[".env.local", { at: NOW - HOUR, size: 412 }], ["node_modules", { at: NOW - DAY }]]))
  assert.deepEqual(carried.map((row) => [row.name, syncWords(row.sync, NOW).words]), [
    [".env.local", "Synced 1 h ago"],
    ["node_modules", "Stays here"],
    ["config/missing.json", "Not here"],
  ])
  assert.match(carried[0]!.detail, /412 B · agents are told never to open it/)

  const cloudFiles = carriedCloudRows(
    {
      project: "/work/shop",
      repository: "https://github.com/acme/shop",
      decision: "allowed",
      files: [
        { path: ".env.local", bytes: 412, credentials: true, cloud: { savedAt: new Date(NOW - DAY).toISOString(), current: false }, kept: false },
        { path: "config/dev.json", bytes: 2_048, credentials: false, cloud: { savedAt: new Date(NOW - 2 * DAY).toISOString(), current: true }, kept: false },
        { path: "keys.pem", bytes: 90, credentials: true, cloud: null, kept: true },
      ],
      staying: [{ path: "fixtures", why: "linked to the main folder, not copied" }],
    },
    "MacBook Pro"
  )
  assert.deepEqual(cloudFiles.map((row) => syncWords(row.sync, NOW).words), ["Mac's is newer", "Synced 2 d ago", "Stays here", "Stays here"])
  const unasked = carriedCloudRows({ project: "/w", repository: "https://github.com/acme/shop", decision: "unasked", files: [{ path: ".env", bytes: 1, credentials: true, cloud: null, kept: false }], staying: [] }, "MacBook Pro")
  assert.equal(syncWords(unasked[0]!.sync, NOW).words, "Not here")

  assert.deepEqual(cloudSignInRows({ sharing: false, harnesses: [] }, (harness) => harness).map((row) => [row.name, row.target, syncWords(row.sync, NOW).words]), [["Your sign-ins", "share-sign-ins", "Not here"]])
  const shared = cloudSignInRows(
    { sharing: true, checkedAt: new Date(NOW - HOUR).toISOString(), harnesses: [{ harness: "claude", status: "sent", label: null, expiresAt: null, sentAt: new Date(NOW - HOUR).toISOString() }, { harness: "codex", status: "failed", label: null, expiresAt: null, problem: "expired" }] },
    (harness) => ({ claude: "Claude Code", codex: "Codex" })[harness] ?? harness
  )
  assert.deepEqual(shared.map((row) => [row.name, syncWords(row.sync, NOW).words]), [["Claude Code", "Synced 1 h ago"], ["Codex", "Didn't copy: expired"]])

  const services = processRows(recipe, cloud, NOW, new Map([["web", 20000]]))
  assert.equal(syncWords(services[0]!.sync, NOW).words, "Up on 20000")
  assert.match(services[0]!.detail, /npm run dev · the Thread's first port/)
})

test("the host reads this device's place and the cloud's from what it holds, and Send copies a carried file again", async () => {
  const { mkdtemp, rm, writeFile, mkdir, utimes } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { SetupViews } = await import("@mako/host/workspaces/setup-view")
  const root = await mkdtemp(join(tmpdir(), "mako-setup-"))
  try {
    await writeFile(join(root, ".env.local"), "NAME=never-read\n")
    await utimes(join(root, ".env.local"), (NOW - HOUR) / 1000, (NOW - HOUR) / 1000)
    await mkdir(join(root, "node_modules"))
    const kept: Array<[string, boolean]> = []
    const carriedView = {
      project: root,
      repository: "https://github.com/acme/shop",
      decision: "allowed" as const,
      files: [{ path: ".env.local", bytes: 16, credentials: true, cloud: { savedAt: new Date(NOW - DAY).toISOString(), current: false }, kept: false }],
      staying: [],
    }
    const views = new SetupViews({
      now: () => NOW,
      recipe: async () => ({
        project: "shop",
        root,
        recipe: {
          kind: "ready",
          source: "mako",
          file: join(root, "recipe.json"),
          savedAt: NOW - DAY,
          earlier: 0,
          versions: [],
          recipe: {
            values: {},
            processes: [{ name: "web", command: "npm run dev", port: "{port}" }],
            checks: {},
            prepare: [{ command: "npm ci", inputs: ["package-lock.json"], outputs: ["**/node_modules"], link: true }],
            carry: [
              { path: ".env.local", link: false, credentials: true },
              { path: "node_modules", link: true, credentials: false },
              { path: "config/dev.json", link: false, credentials: false },
            ],
            oneAtATime: false,
          },
        },
      }),
      carried: {
        view: async () => carriedView,
        decide: async () => carriedView,
        keep: async (_folder, path, keep) => {
          kept.push([path, keep])
          return carriedView
        },
      },
      cloudSignIns: { state: async () => ({ sharing: false, harnesses: [] }), share: async () => undefined },
      accounts: async () => ({ providers: [], accounts: [{ harness: "claude", name: "work", dir: "/x", active: true }] }),
      keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
      device: async () => ({ id: "mac-1", name: "MacBook Pro" }),
      label: (harness) => (harness === "claude" ? "Claude Code" : harness),
    })
    const page = await views.view(root)
    assert.deepEqual(page.places.map((place) => place.id), ["device:this-device", "cloud"])
    const [here, there] = page.places
    const words = (place: SetupPlaceView) => Object.fromEntries(rows(place).map((row) => [row.name, syncWords(row.sync, NOW).words]))
    assert.deepEqual(words(here!), {
      "acme/shop": "Synced just now",
      ".env.local": "Synced 1 h ago",
      node_modules: "Stays here",
      "config/dev.json": "Not here",
      "Claude Code": "Stays here",
      "npm ci": "Synced 1 d ago",
      web: "Stays here",
    })
    assert.equal(words(there!)[".env.local"], "Mac's is newer")
    assert.equal(words(there!)["Your sign-ins"], "Not here")
    assert.ok(!JSON.stringify(page).includes("never-read"), "a file's contents never reach the page")
    const send = rows(there!).find((row) => row.name === ".env.local")!
    assert.deepEqual(await views.act(root, { act: "row", place: "cloud", row: send.id, action: "send" }), { done: true })
    assert.deepEqual(kept, [[".env.local", false]])
    const answered = await views.act(root, { act: "answer", ask: "a", answer: "decline" })
    assert.equal(answered.done, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the host reads this device's own brokers and the account's, and answers and stops where each is kept", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { SetupViews } = await import("@mako/host/workspaces/setup-view")
  const { LocalBorrowing } = await import("@mako/host/base/local-borrowing")
  const { CHECKOUT_SOURCES, LOCAL_DEVICE, checkoutGrants } = await import("@mako/host/workspaces/checkout-borrowing")
  const { GrantedSecrets } = await import("@mako/host/base/secret-grants")
  const { memorySecrets } = await import("@mako/host/base/secrets")
  const root = await mkdtemp(join(tmpdir(), "mako-setup-brokers-"))
  try {
    await writeFile(join(root, ".env.local"), "NAME=never-read\n")
    await writeFile(join(root, "notes.md"), "# notes\n")
    const checkouts = new LocalBorrowing({ device: LOCAL_DEVICE, account: "local", sources: CHECKOUT_SOURCES })
    for (const seeded of checkoutGrants(LOCAL_DEVICE, "local", NOW - DAY)) await checkouts.grant(seeded)
    await checkouts.grant({
      id: "g-notes-first",
      resource: { kind: "file", ref: "notes.md" },
      source: { kind: "device", device: LOCAL_DEVICE },
      scope: { level: "thread", account: "local", thread: "t-2" },
      within: "source-device",
      mode: "copy",
      access: "read",
      lifetime: { until: "revoked" },
      ask: "first-use",
      secret: false,
      grantedBy: { kind: "person", account: "local" },
      grantedAt: NOW - DAY,
      version: 1,
    })
    const borrower = { account: "local", repository: root, thread: "t-1", place: { kind: "device" as const, device: LOCAL_DEVICE } }
    const copied = await checkouts.borrow({ kind: "file", ref: ".env.local", for: borrower, why: "the recipe's carry", correlationId: "c-env", mode: "copy" })
    assert.ok("lease" in copied)
    const waiting = await checkouts.borrow({ kind: "file", ref: "notes.md", for: { ...borrower, thread: "t-2" }, why: "read the notes", correlationId: "c-notes" })
    assert.ok("pending" in waiting)
    const saved = new GrantedSecrets(memorySecrets())
    await saved.write("saved-key", "openai", "sk-never-shown")
    const revoked: string[] = []
    const lent: Grant = { ...grant("g-lent", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: "cloud-mac-id" }, mode: "live" }), scope: { level: "account", account: ACCOUNT } }
    const views = new SetupViews({
      now: () => NOW,
      recipe: async () => ({ project: "shop", root, recipe: { kind: "none" } }),
      accounts: async () => ({ providers: [], accounts: [] }),
      keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
      device: async () => ({ id: "cloud-mac-id", name: "MacBook Pro" }),
      label: (harness) => harness,
      borrowing: {
        local: async () => [checkouts, saved.broker],
        account: { snapshot: async () => ({ grants: [lent], leases: [], events: [], asks: [] }), answer: async () => undefined, revoke: async (id) => void revoked.push(id) },
        asker: (thread) => (thread === "t-2" ? { thread, title: "Pricing notes", fin: false } : undefined),
        secretVersion: (kind, name) => saved.version(kind, name),
      },
    })
    const page = await views.view(root)
    const here = page.places[0]!
    assert.equal(here.id, `device:${LOCAL_DEVICE}`)
    const names = rows(here).map((row) => row.name)
    assert.ok(names.includes(".env.local"), names.join(", "))
    assert.equal(named(here, ".env.local").origin.from, "lease")
    assert.ok(names.includes("Saved key: openai"))
    assert.equal(named(here, "Saved key: openai").part, "access")
    assert.equal(rowAction(named(here, "~/notes"), NOW), "stop", "the account's grant sourced from this Mac is lent from here")
    assert.ok(!JSON.stringify(page).includes("never-read") && !JSON.stringify(page).includes("sk-never-shown"))

    assert.deepEqual(here.asks.map((ask) => [ask.by.title, askLine(ask).thing]), [["Pricing notes", "notes.md"]])
    assert.deepEqual(await views.act(root, { act: "answer", ask: here.asks[0]!.id, answer: "allow-thread" }), { done: true })
    assert.equal((await checkouts.asks()).length, 0)
    assert.equal((await checkouts.leases()).filter((held) => held.resource.ref === "notes.md").length, 1)

    // A credential ask is answered yes by the saved record's version alone, and the lease names that version.
    await checkouts.grant({
      id: "g-key-first",
      resource: { kind: "credential", ref: "saved-key/openai" },
      source: { kind: "device", device: LOCAL_DEVICE },
      scope: { level: "thread", account: "local", thread: "t-3" },
      within: "source-device",
      mode: "copy",
      access: "read",
      lifetime: { until: "revoked" },
      ask: "first-use",
      secret: true,
      grantedBy: { kind: "person", account: "local" },
      grantedAt: NOW - DAY,
      version: 1,
    })
    const keyAsk = await checkouts.borrow({ kind: "credential", ref: "saved-key/openai", for: { ...borrower, thread: "t-3" }, why: "call the model", correlationId: "c-key", mode: "copy" })
    assert.ok("pending" in keyAsk)
    const askedKey = (await views.view(root)).places[0]!.asks.find((entry) => askLine(entry).thing === "saved-key/openai")!
    assert.deepEqual(await views.act(root, { act: "answer", ask: askedKey.id, answer: "allow-thread" }), { done: true })
    const keyLease = (await checkouts.leases()).find((held) => held.resource.ref === "saved-key/openai")!
    assert.equal(keyLease.version, await saved.version("saved-key", "openai"))
    assert.ok(!JSON.stringify(keyLease).includes("sk-never-shown"))

    const stopLent = rows(here).find((row) => row.name === "~/notes")!
    assert.deepEqual(await views.act(root, { act: "row", place: here.id, row: stopLent.id, action: "stop" }), { done: true })
    assert.deepEqual(revoked, ["g-lent"])
    const stopLocal = rows((await views.view(root)).places[0]!).find((row) => row.name.startsWith("Files Git ignores") && row.name.includes("copied"))!
    assert.deepEqual(await views.act(root, { act: "row", place: here.id, row: stopLocal.id, action: "stop" }), { done: true })
    assert.ok(!(await checkouts.grants()).some((held) => held.id === "device-checkouts-copy"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("one file's Add never copies the project's other files: the project's word has a row of its own naming them all", async () => {
  const { SetupViews } = await import("@mako/host/workspaces/setup-view")
  for (const decision of ["unasked", "declined"] as const) {
    const calls: string[] = []
    const carriedView = {
      project: "/work/shop",
      repository: "https://github.com/acme/shop",
      decision,
      files: [
        { path: "selected.env", bytes: 10, credentials: true, cloud: null, kept: false },
        { path: "unselected.env", bytes: 10, credentials: true, cloud: null, kept: false },
      ],
      staying: [],
    }
    const views = new SetupViews({
      now: () => NOW,
      recipe: async () => ({ project: "shop", root: "/work/shop", recipe: { kind: "none" } }),
      carried: {
        view: async () => carriedView,
        decide: async (_folder, allowed) => {
          calls.push(`decide:${allowed}`)
          return carriedView
        },
        keep: async (_folder, path, keep) => {
          calls.push(`keep:${path}:${keep}`)
          return carriedView
        },
      },
      accounts: async () => ({ providers: [], accounts: [] }),
      keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
      device: async () => ({ id: undefined, name: "MacBook Pro" }),
      label: (harness) => harness,
    })
    const cloudPlace = (await views.view("/work/shop")).places.find((place) => place.id === "cloud")!
    const selected = named(cloudPlace, "selected.env")
    assert.equal(rowAction(selected, NOW), undefined, `${decision}: a file's own row offers no Add`)
    const forced = await views.act("/work/shop", { act: "row", place: "cloud", row: selected.id, action: "add" })
    assert.equal(forced.done, false, `${decision}: Add on one file is refused`)
    assert.deepEqual(calls, [], `${decision}: neither file was sent, and the project's word wasn't given`)
    const project = rows(cloudPlace).find((row) => row.target === "carried:all")!
    assert.match(project.detail, /selected\.env and unselected\.env/, "the project's row names every file its Add covers")
    assert.equal(rowAction(project, NOW), "add")
    assert.deepEqual(await views.act("/work/shop", { act: "row", place: "cloud", row: project.id, action: "add" }), { done: true })
    assert.deepEqual(calls, ["decide:true"])
  }
})
