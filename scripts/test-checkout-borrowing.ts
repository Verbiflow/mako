import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKOUT_GRANTS, CheckoutBorrowing, LOCAL_ACCOUNT, LOCAL_DEVICE, checkoutSource } from "@mako/host/workspaces/checkout-borrowing"
import { LocalBorrowing } from "@mako/host/workspaces/local-borrowing"

/**
 * What a worktree takes from its main checkout, as borrowing: each entry the recipe's carry or worktree_bring
 * places is a lease of this device's broker under its checkout grants. The log names what came, never its bytes;
 * revoking a grant takes what it placed out of every worktree; a lapsed lease is taken again; the broker's state
 * outlives the host; and the device's grants never reach a borrower at another place.
 */

const git = new Git()
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkout-borrowing-")))
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const main = join(root, "shop")
mkdirSync(join(main, "models"), { recursive: true })
run(main, "init", "-q", "-b", "main")
run(main, "config", "user.email", "test@example.invalid")
run(main, "config", "user.name", "Test")
writeFileSync(join(main, ".gitignore"), ".env\nmodels/\nlocal.json\n")
writeFileSync(join(main, "README.md"), "shop\n")
run(main, "add", ".")
run(main, "commit", "-q", "-m", "first")
const CANARY = "VALUE-7f3a9c-never-in-a-log"
writeFileSync(join(main, ".env"), `API_KEY=${CANARY}\n`)
writeFileSync(join(main, "local.json"), "{}\n")
writeFileSync(join(main, "models", "weights.bin"), "weights\n")

const worktree = join(root, "worktrees", "shop-1")
run(main, "worktree", "add", "-q", "-b", "mako/one", worktree)
const folder = join(root, "borrowing")
let borrowing = CheckoutBorrowing.open(git, folder)

// The recipe's carry: a copy and a link, each a lease under the device's grants.
const carried = await borrowing.carry("thread-1", main, worktree, [{ path: ".env", link: false }, { path: "models", link: true }])
assert.equal(carried.copied, 2)
assert.deepEqual(carried.refused, [])
assert.equal(readFileSync(join(worktree, ".env"), "utf8"), `API_KEY=${CANARY}\n`)
assert.ok(existsSync(join(worktree, "models", "weights.bin")))
const leases = await borrowing.borrowing.leases({ borrower: { thread: "thread-1" } })
assert.deepEqual(leases.map((lease) => [lease.resource.ref, lease.mode, lease.grant]).sort(), [[".env", "copy", CHECKOUT_GRANTS.copy], ["models", "live", CHECKOUT_GRANTS.live]])
assert.ok(leases.every((lease) => lease.borrower.place.kind === "device" && lease.borrower.repository === main))

// The same carry again is the same leases: nothing new is granted, and the worktree's own copy is left as it is.
writeFileSync(join(worktree, ".env"), "API_KEY=edited-here\n")
await borrowing.carry("thread-1", main, worktree, [{ path: ".env", link: false }, { path: "models", link: true }])
assert.equal(readFileSync(join(worktree, ".env"), "utf8"), "API_KEY=edited-here\n", "a retry never overwrites what the worktree wrote")
const granted = []
for await (const event of borrowing.borrowing.events()) if (event.event === "granted") granted.push(event)
assert.equal(granted.length, 2, "one need, one lease, however often it's asked")

// worktree_bring: an entry outside any recipe is a need like any other.
const brought = await borrowing.bring("thread-1", main, worktree, [{ path: "local.json" }, { path: "nothing-here" }])
assert.deepEqual(brought.copied, ["local.json"])
assert.deepEqual(brought.missing, ["nothing-here"])

// The log and the broker's state on disk hold names and versions, never a value.
const disk = readFileSync(join(folder, "events.jsonl"), "utf8") + readFileSync(join(folder, "state.json"), "utf8") + readFileSync(join(folder, "placed.json"), "utf8")
assert.ok(!disk.includes(CANARY), "no value in the lease log, the broker's state or the index")
assert.ok(disk.includes('"event":"granted"'))

// The device's grants keep to it: a cloud machine of the same account and project is refused, typed.
const away = await borrowing.borrowing.borrow({
  kind: "file",
  ref: ".env",
  for: { account: LOCAL_ACCOUNT, repository: main, thread: "cloud-thread", place: { kind: "machine", machine: "m-1" } },
  why: "a cloud Thread wants it",
  correlationId: "away-1",
})
assert.equal("refusal" in away && away.refusal.refused, "out-of-scope")

// The state outlives the host: a new broker over the same folder holds the same leases.
borrowing = CheckoutBorrowing.open(git, folder)
assert.equal((await borrowing.borrowing.leases({ borrower: { thread: "thread-1" } })).length, 3)

// Revoking the link grant takes its links out of the worktree; what the worktree made in the folder stays.
writeFileSync(join(worktree, "models", "made-here.txt"), "mine\n")
await borrowing.borrowing.revoke(CHECKOUT_GRANTS.live, { kind: "person", account: LOCAL_ACCOUNT })
await borrowing.keep()
assert.ok(!existsSync(join(worktree, "models", "weights.bin")), "the link to the main checkout's file is gone")
assert.ok(existsSync(join(worktree, "models", "made-here.txt")), "a file the worktree made stays")
assert.ok(existsSync(join(main, "models", "weights.bin")), "the main checkout's own is untouched")

// Revoking the copy grant takes its copies out too, and a new bring is refused in words; seeding again doesn't undo the person's revoke.
await borrowing.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
await borrowing.keep()
assert.ok(!existsSync(join(worktree, ".env")) && !existsSync(join(worktree, "local.json")), "a revoked copy leaves the worktree")
borrowing = CheckoutBorrowing.open(git, folder)
const refused = await borrowing.bring("thread-1", main, worktree, [{ path: ".env" }])
assert.deepEqual(refused.copied, [])
assert.deepEqual(refused.refused, [".env: the grant for it was revoked"])
assert.equal(lstatSync(join(main, ".env")).isFile(), true)

// A lease that lapsed while the device was off is taken again at the next keep, not taken away.
let now = Date.now()
const clock = () => now
const lapsing = new CheckoutBorrowing({ git, borrowing: new LocalBorrowing({ device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, source: checkoutSource, now: clock }) })
const other = join(root, "worktrees", "shop-2")
run(main, "worktree", "add", "-q", "-b", "mako/two", other)
await lapsing.carry("thread-2", main, other, [{ path: ".env", link: false }])
const [before] = await lapsing.borrowing.leases()
now += 25 * 60 * 60_000
await lapsing.keep()
const [after] = await lapsing.borrowing.leases()
assert.ok(before && after && after.id !== before.id, "a new lease replaces the lapsed one")
assert.equal(readFileSync(join(other, ".env"), "utf8"), `API_KEY=${CANARY}\n`, "and the worktree keeps its copy")

// A removed worktree releases what it held.
await lapsing.forget(other)
assert.equal((await lapsing.borrowing.leases()).length, 0)

console.log("checkout borrowing: carry and bring as leases, one lease per need, no value on disk, the device's grants keep to it, state kept across hosts, revocation removes links and copies but not the worktree's own files, refusals in words, revoked stays revoked, lapsed leases taken again, removal releases")
