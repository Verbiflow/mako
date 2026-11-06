import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKOUT_GRANTS, CHECKOUT_SOURCES, CheckoutBorrowing, LOCAL_ACCOUNT, LOCAL_DEVICE } from "@mako/host/workspaces/checkout-borrowing"
import { LocalBorrowing } from "@mako/host/base/local-borrowing"

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
const lapsing = new CheckoutBorrowing({ git, borrowing: new LocalBorrowing({ device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, sources: CHECKOUT_SOURCES, now: clock }) })
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


// Mako removes only what it made. A file and a folder the worktree had before are left alone when the grant goes,
// and so is a file put in place of Mako's copy since.
{
  const own = join(root, "worktrees", "shop-own")
  run(main, "worktree", "add", "-q", "-b", "mako/own", own)
  const ownFolder = join(root, "borrowing-own")
  const keeper = CheckoutBorrowing.open(git, ownFolder)
  writeFileSync(join(own, "local.json"), "the person's own\n")
  mkdirSync(join(own, "models"))
  writeFileSync(join(own, "models", "mine.bin"), "the person's own\n")
  const before = await keeper.bring("thread-own", main, own, [{ path: "local.json" }, { path: "models" }, { path: ".env" }])
  assert.deepEqual(before.existing.sort(), ["local.json", "models"])
  assert.deepEqual(before.copied, [".env"])
  // The agent replaces Mako's copy with a file of its own.
  rmSync(join(own, ".env"))
  writeFileSync(join(own, ".env"), "the agent's own\n")
  await keeper.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await keeper.keep()
  assert.equal(readFileSync(join(own, "local.json"), "utf8"), "the person's own\n", "an existing file is never deleted")
  assert.equal(readFileSync(join(own, "models", "mine.bin"), "utf8"), "the person's own\n", "nor an existing folder")
  assert.equal(readFileSync(join(own, ".env"), "utf8"), "the agent's own\n", "nor a file put where Mako's copy was")
}

// Inside a folder Mako copied, what the person adds is theirs: a revoke takes Mako's files and leaves theirs, with
// the folders that hold them.
{
  const inside = join(root, "worktrees", "shop-inside")
  run(main, "worktree", "add", "-q", "-b", "mako/inside", inside)
  const keeper = CheckoutBorrowing.open(git, join(root, "borrowing-inside"))
  const brought = await keeper.bring("thread-inside", main, inside, [{ path: "models" }])
  assert.deepEqual(brought.copied, ["models"])
  assert.ok(existsSync(join(inside, "models", "weights.bin")))
  writeFileSync(join(inside, "models", "notes.md"), "the person's own\n")
  mkdirSync(join(inside, "models", "runs"))
  writeFileSync(join(inside, "models", "runs", "one.json"), "the person's own\n")
  await keeper.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await keeper.keep()
  assert.ok(!existsSync(join(inside, "models", "weights.bin")), "Mako's copied file goes")
  assert.equal(readFileSync(join(inside, "models", "notes.md"), "utf8"), "the person's own\n", "a file the person added inside stays")
  assert.equal(readFileSync(join(inside, "models", "runs", "one.json"), "utf8"), "the person's own\n", "and one in a folder they made there")
}

// A file the person makes inside a folder the moment Mako's copy lands is theirs, never claimed as Mako's: a revoke,
// and a restart after it, leave it.
{
  const racing = join(root, "worktrees", "shop-racing")
  run(main, "worktree", "add", "-q", "-b", "mako/racing", racing)
  const folder = join(root, "borrowing-racing")
  const keeper = CheckoutBorrowing.open(git, folder, {}, undefined, async (checkout) => {
    if (existsSync(join(checkout, "models"))) writeFileSync(join(checkout, "models", "raced.md"), "the person's own\n")
  })
  await keeper.bring("thread-racing", main, racing, [{ path: "models" }])
  await keeper.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await CheckoutBorrowing.open(git, folder).keep()
  assert.ok(!existsSync(join(racing, "models", "weights.bin")), "Mako's copy goes")
  assert.equal(readFileSync(join(racing, "models", "raced.md"), "utf8"), "the person's own\n", "a file made as it landed stays")
}

// A removal the file system refuses (a folder made unreadable) stays written down, and finishes once it can,
// in a host opened after.
{
  const locked = join(root, "worktrees", "shop-locked")
  run(main, "worktree", "add", "-q", "-b", "mako/locked", locked)
  const folder = join(root, "borrowing-locked")
  const keeper = CheckoutBorrowing.open(git, folder)
  await keeper.bring("thread-locked", main, locked, [{ path: "models" }])
  await keeper.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  chmodSync(join(locked, "models"), 0o000)
  try {
    await keeper.keep()
  } finally {
    chmodSync(join(locked, "models"), 0o700)
  }
  assert.ok(existsSync(join(locked, "models", "weights.bin")), "the refused removal left the copy")
  // SAFETY: the index is the broker's own file, written whole by it.
  const index = JSON.parse(readFileSync(join(folder, "placed.json"), "utf8")) as Array<{ entry: string; removing?: boolean }>
  assert.deepEqual(index.map((item) => [item.entry, item.removing]), [["models", true]], "and its removal is still written down")
  await CheckoutBorrowing.open(git, folder).keep()
  assert.ok(!existsSync(join(locked, "models", "weights.bin")), "a host opened after finishes it")
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "placed.json"), "utf8")), [])
}

// A revoke always wins over a placement: one that falls after a placement is staged and before it lands stops it
// landing, and one that falls after it landed takes it away. Nothing is left that the index doesn't know.
{
  const person = { kind: "person", account: LOCAL_ACCOUNT } as const
  const opened = (name: string, beforeLanding?: (broker: CheckoutBorrowing) => Promise<void>) => {
    const broker: CheckoutBorrowing = new CheckoutBorrowing({
      git,
      borrowing: new LocalBorrowing({ device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, sources: CHECKOUT_SOURCES, folder: join(root, name) }),
      ...(beforeLanding && { beforeLanding: () => beforeLanding(broker) }),
    })
    return broker
  }
  const indexOf = (name: string) => JSON.parse(readFileSync(join(root, name, "placed.json"), "utf8"))
  const staging = () => readdirSync(join(root, "worktrees")).filter((name) => name.startsWith("."))
  const emptied = () => staging().every((name) => readdirSync(join(root, "worktrees", name)).length === 0)

  // A copy: the revoke and its removal finish while the destination is still free.
  const copied = join(root, "worktrees", "shop-revoked-copy")
  run(main, "worktree", "add", "-q", "-b", "mako/revoked-copy", copied)
  const copying = opened("borrowing-revoked-copy", async (broker) => {
    await broker.borrowing.revoke(CHECKOUT_GRANTS.copy, person)
    await broker.keep()
  })
  const report = await copying.bring("thread-revoked", main, copied, [{ path: ".env" }])
  assert.deepEqual(report.copied, [], "a revoked placement isn't reported as placed")
  assert.deepEqual(report.existing, [])
  assert.deepEqual(report.refused, [".env: the grant for it was revoked"])
  assert.ok(!existsSync(join(copied, ".env")), "and it never landed")
  await opened("borrowing-revoked-copy").keep()
  assert.ok(!existsSync(join(copied, ".env")), "nor does it after a restart")
  assert.deepEqual(indexOf("borrowing-revoked-copy"), [])

  // A folder and a link, revoked by another broker over the same folder, which this one only sees on disk.
  const linked = join(root, "worktrees", "shop-revoked-link")
  run(main, "worktree", "add", "-q", "-b", "mako/revoked-link", linked)
  const linking = opened("borrowing-revoked-link", async () => {
    const other = opened("borrowing-revoked-link")
    await other.borrowing.revoke(CHECKOUT_GRANTS.live, person)
    await other.keep()
  })
  const carried = await linking.carry("thread-revoked", main, linked, [{ path: "models", link: true }])
  assert.equal(carried.copied, 0)
  assert.deepEqual(carried.refused, ["models: the grant for it was revoked"])
  assert.ok(!existsSync(join(linked, "models")))
  assert.deepEqual(indexOf("borrowing-revoked-link"), [])

  // A copy made over a link: the clone goes, and the link is as it was.
  const owning = join(root, "worktrees", "shop-revoked-own")
  run(main, "worktree", "add", "-q", "-b", "mako/revoked-own", owning)
  const linkedFirst = opened("borrowing-revoked-own", async (broker) => {
    if (!existsSync(join(owning, "models"))) return
    await broker.borrowing.revoke(CHECKOUT_GRANTS.copy, person)
    await broker.keep()
  })
  await linkedFirst.bring("thread-revoked", main, owning, [{ path: "models", link: true }])
  const own = await linkedFirst.bring("thread-revoked", main, owning, [{ path: "models" }])
  assert.deepEqual([own.owned, own.existing, own.refused], [[], [], ["models: the grant for it was revoked"]])
  assert.ok(lstatSync(join(owning, "models", "weights.bin")).isSymbolicLink(), "the link stays under its own grant")
  assert.ok(emptied(), "and nothing is left staged")

  // Just after it landed, before the broker has finished with it: the removal takes it, however the placement ends.
  const landed = join(root, "worktrees", "shop-revoked-landed")
  run(main, "worktree", "add", "-q", "-b", "mako/revoked-landed", landed)
  const landing: CheckoutBorrowing = CheckoutBorrowing.open(git, join(root, "borrowing-revoked-landed"), {}, undefined, async () => {
    await landing.borrowing.revoke(CHECKOUT_GRANTS.copy, person)
    await landing.keep()
  })
  await landing.bring("thread-revoked", main, landed, [{ path: ".env" }])
  assert.ok(!existsSync(join(landed, ".env")))
  await opened("borrowing-revoked-landed").keep()
  assert.ok(!existsSync(join(landed, ".env")))
  assert.deepEqual(indexOf("borrowing-revoked-landed"), [])
}

// A lease taken again keeps what its placement made: a revoke after it removes the copy, in memory, on disk, and on
// a host opened after the lease moved.
for (const kept of ["memory", "disk", "restart"] as const) {
  let at = Date.now()
  const lapsed = join(root, "worktrees", `shop-retaken-${kept}`)
  run(main, "worktree", "add", "-q", "-b", `mako/retaken-${kept}`, lapsed)
  const options = { device: LOCAL_DEVICE, account: LOCAL_ACCOUNT, sources: CHECKOUT_SOURCES, now: () => at }
  const place = () => new CheckoutBorrowing({ git, borrowing: new LocalBorrowing(kept === "memory" ? options : { ...options, folder: join(root, `borrowing-retaken-${kept}`) }) })
  const held = place()
  await held.bring("thread-retaken", main, lapsed, [{ path: ".env" }, { path: "models" }])
  at += 25 * 60 * 60_000
  await held.keep()
  const broker = kept === "restart" ? place() : held
  await broker.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await broker.keep()
  assert.ok(!existsSync(join(lapsed, ".env")), `a copy taken again goes with the revoke (${kept})`)
  assert.ok(!existsSync(join(lapsed, "models")), `and a folder (${kept})`)
  if (kept !== "memory") assert.deepEqual(JSON.parse(readFileSync(join(root, `borrowing-retaken-${kept}`, "placed.json"), "utf8")), [])
}

// A removal that fails, or that a crash cuts short, is written down and finished by the next keep.
{
  const flaky = join(root, "worktrees", "shop-flaky")
  run(main, "worktree", "add", "-q", "-b", "mako/flaky", flaky)
  const flakyFolder = join(root, "borrowing-flaky")
  let failing = true
  const remove = async (path: string, recursive: boolean) => {
    if (failing) throw new Error("the disk said no")
    rmSync(path, { recursive, force: true })
  }
  const first = CheckoutBorrowing.open(git, flakyFolder, {}, remove)
  await first.bring("thread-flaky", main, flaky, [{ path: ".env" }])
  await first.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await first.keep()
  assert.ok(existsSync(join(flaky, ".env")), "the delete failed")
  // SAFETY: the index is the broker's own file, written whole by it.
  const index = JSON.parse(readFileSync(join(flakyFolder, "placed.json"), "utf8")) as Array<{ entry: string; removing?: boolean }>
  assert.deepEqual(index.map((item) => [item.entry, item.removing]), [[".env", true]], "and its removal is still written down")
  failing = false
  // A new host over the same folder, as after a crash, finishes it.
  await CheckoutBorrowing.open(git, flakyFolder, {}, remove).keep()
  assert.ok(!existsSync(join(flaky, ".env")), "the next keep finished the removal")
  assert.deepEqual(JSON.parse(readFileSync(join(flakyFolder, "placed.json"), "utf8")), [])
}

// Two brokers over one folder are one broker: one opened before a revoke can't bring the grant back, in this
// process or another, and two writing at once lose nothing.
{
  const sharedFolder = join(root, "borrowing-shared")
  const shared = join(root, "worktrees", "shop-shared")
  run(main, "worktree", "add", "-q", "-b", "mako/shared", shared)
  const early = CheckoutBorrowing.open(git, sharedFolder)
  const late = CheckoutBorrowing.open(git, sharedFolder)
  await early.seed()
  await late.seed()
  const names = Array.from({ length: 12 }, (_, index) => `file-${index}.json`)
  for (const name of names) writeFileSync(join(main, name), "{}\n")
  writeFileSync(join(main, ".git", "info", "exclude"), "file-*.json\n")
  await Promise.all(names.map((name, index) => (index % 2 ? early : late).bring("thread-shared", main, shared, [{ path: name }])))
  assert.equal((await early.borrowing.leases({ borrower: { thread: "thread-shared" } })).length, names.length, "no lease lost between two writers")
  await late.borrowing.revoke(CHECKOUT_GRANTS.copy, { kind: "person", account: LOCAL_ACCOUNT })
  await early.borrowing.tick()
  await early.seed()
  assert.ok(!(await CheckoutBorrowing.open(git, sharedFolder).borrowing.grants()).some((grant) => grant.id === CHECKOUT_GRANTS.copy), "the revoke stands after the other broker writes")
  const refused = await early.bring("thread-shared", main, shared, [{ path: ".env" }])
  assert.deepEqual(refused.refused, [".env: the grant for it was revoked"])
  await early.keep()
  assert.ok(names.every((name) => !existsSync(join(shared, name))), "the other broker's keep removes what the revoke ended")

  // Another process revokes the link grant while this one holds its broker open.
  execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const { CheckoutBorrowing, CHECKOUT_GRANTS, LOCAL_ACCOUNT } = await import("@mako/host/workspaces/checkout-borrowing")
    const { Git } = await import("@mako/git")
    const other = CheckoutBorrowing.open(new Git(), ${JSON.stringify(sharedFolder)})
    await other.borrowing.revoke(CHECKOUT_GRANTS.live, { kind: "person", account: LOCAL_ACCOUNT })
  `], { cwd: process.cwd(), stdio: "inherit" })
  await early.seed()
  const linked = await early.bring("thread-shared", main, shared, [{ path: "models", link: true }])
  assert.deepEqual(linked.refused, ["models: the grant for it was revoked"], "a revoke from another process stands")
}

console.log("checkout borrowing: carry and bring as leases, one lease per need, no value on disk, the device's grants keep to it, state kept across hosts, revocation removes links and copies but not the worktree's own files, refusals in words, revoked stays revoked, lapsed leases taken again, removal releases, nothing Mako didn't make is removed, not even inside a folder it copied, nor one made as the copy landed, a refused removal stays written down until it's done, a revoke stops a placement before it lands and takes it after, a lease taken again keeps what it placed, a failed or interrupted removal is finished, two brokers and two processes over one folder are one broker")
