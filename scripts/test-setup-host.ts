import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rowAction, syncWords, type SetupPlaceView } from "@mako/host/contracts/setup"
import { CHECKOUT_GRANTS, CheckoutBorrowing, LOCAL_DEVICE } from "@mako/host/workspaces/checkout-borrowing"
import { GrantedSecrets } from "@mako/host/base/secret-grants"
import { memorySecrets } from "@mako/host/base/secrets"
import { SetupViews } from "@mako/host/workspaces/setup-view"

/**
 * Setup on this device's real brokers: a main checkout and a worktree of it, the recipe's carry placed by the
 * worktrees' broker, and a key saved in the profile's secrets. The Files part shows the device's two checkout grants
 * and each entry a worktree took; Accounts and secrets shows the saved key by name; Stop revokes the copy grant and
 * its leases end. Nothing a file or a key holds reaches the page. `MAKO_SETUP_PAGE=<file>` writes the page read, for
 * the fixture page to draw (`scripts/setup-check.html?page=`).
 */

const git = new Git()
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-setup-host-")))
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
try {
  const main = join(root, "shop")
  mkdirSync(join(main, "fixtures"), { recursive: true })
  run(main, "init", "-q", "-b", "main")
  run(main, "config", "user.email", "test@example.invalid")
  run(main, "config", "user.name", "Test")
  writeFileSync(join(main, ".gitignore"), ".env.local\nfixtures/\n")
  writeFileSync(join(main, "README.md"), "shop\n")
  run(main, "add", ".")
  run(main, "commit", "-q", "-m", "first")
  const CANARY = "VALUE-91c2-never-on-a-page"
  writeFileSync(join(main, ".env.local"), `API_KEY=${CANARY}\n`)
  writeFileSync(join(main, "fixtures", "recording.json"), "{}\n")
  const worktree = join(root, "worktrees", "shop-1")
  run(main, "worktree", "add", "-q", "-b", "mako/one", worktree)

  const checkouts = CheckoutBorrowing.open(git, join(root, "borrowing"))
  const carry = [{ path: ".env.local", link: false, credentials: true }, { path: "fixtures", link: true, credentials: false }]
  const carried = await checkouts.carry("thread-1", main, worktree, carry)
  assert.equal(carried.copied, 2)
  const secrets = new GrantedSecrets(memorySecrets())
  await secrets.write("saved-key", "openai", "sk-never-on-a-page")

  const views = new SetupViews({
    recipe: async () => ({
      project: "shop",
      root: main,
      recipe: {
        kind: "ready",
        source: "mako",
        file: join(root, "recipe.json"),
        earlier: 0,
        versions: [],
        recipe: { values: {}, processes: [{ name: "web", command: "npm run dev", port: "{port}" }], checks: {}, prepare: [{ command: "npm ci", inputs: ["package-lock.json"], outputs: ["**/node_modules"], link: true }], carry, oneAtATime: false },
      },
    }),
    accounts: async () => ({ providers: [], accounts: [{ harness: "claude", name: "work", dir: "/x", active: true }] }),
    keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
    device: async () => ({ id: undefined, name: "MacBook Pro" }),
    label: (harness) => (harness === "claude" ? "Claude Code" : harness),
    borrowing: { local: async () => [checkouts.borrowing, secrets.broker] },
  })
  const page = await views.view(main)
  if (process.env.MAKO_SETUP_PAGE) await writeFile(process.env.MAKO_SETUP_PAGE, JSON.stringify(page))
  const here = page.places.find((place) => place.id === `device:${LOCAL_DEVICE}`)
  assert.ok(here, page.places.map((place) => place.id).join(", "))
  const part = (view: SetupPlaceView, name: string) => view.parts.find((entry) => entry.part === name)!.rows
  const files = part(here, "files")
  const grants = files.filter((row) => row.origin.from === "grant").map((row) => row.target)
  assert.deepEqual(grants.sort(), [CHECKOUT_GRANTS.copy, CHECKOUT_GRANTS.live].sort(), "the device's two checkout grants")
  const env = files.find((row) => row.name === ".env.local")
  assert.ok(env, files.map((row) => row.name).join(", "))
  assert.equal(env.origin.from, "lease", "the copy a worktree took, as its lease")
  assert.equal(env.detail, "Copied into 1 Thread's worktree")
  assert.match(syncWords(env.sync, page.at).words, /^Synced /)
  const linked = files.find((row) => row.name === "fixtures")
  assert.equal(linked?.detail, "Linked into 1 Thread's worktree")
  assert.equal(files.filter((row) => row.name === ".env.local").length, 1, "the lease's row takes the carry reading's place")
  const access = part(here, "access").map((row) => row.name)
  assert.ok(access.includes("Saved key: openai"), access.join(", "))
  const text = JSON.stringify(page)
  assert.ok(!text.includes(CANARY) && !text.includes("sk-never-on-a-page"), "no value on the page")

  const copyGrant = files.find((row) => row.target === CHECKOUT_GRANTS.copy && row.origin.from === "grant")!
  assert.equal(rowAction(copyGrant, page.at), "stop")
  assert.deepEqual(await views.act(main, { act: "row", place: here.id, row: copyGrant.id, action: "stop" }), { done: true })
  assert.ok(!(await checkouts.borrowing.grants()).some((grant) => grant.id === CHECKOUT_GRANTS.copy))
  assert.deepEqual((await checkouts.borrowing.leases()).map((lease) => lease.resource.ref), ["fixtures"], "the copy grant's lease ended with it")
  console.log("Setup on real brokers: the checkout grants and a worktree's lease in Files, a saved key by name, Stop revoking the grant")
} finally {
  await git.close()
  rmSync(root, { recursive: true, force: true })
}
