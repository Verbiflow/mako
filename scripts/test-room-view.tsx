import assert from "node:assert/strict"

/**
 * The Status view's Room, rendered from the rail scene: a row per app with
 * its memory and what it's doing, each project's fit, and the memory line;
 * stopping asks first only for apps that aren't the one in view.
 */

const saved = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})

const { renderToStaticMarkup } = await import("react-dom/server")
const { RoomList } = await import("@/components/rail/room-section")
const { WorkspaceFocusContext } = await import("@/components/stage/workspace-focus-context")
const { fitLine, othersAmong, roomDetail, roomMemory, roomTitle } = await import("@/lib/room")
const { railRoom } = await import("@/dev/mock-rail-worktrees")

const now = Date.UTC(2026, 9, 3, 12)
const room = railRoom(now)
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/\u00a0/g, " ").split("\n").map((line) => line.trim()).filter(Boolean)
const lines = text(renderToStaticMarkup(<RoomList room={room} />))

assert.equal(lines[0], "Room")
assert.equal(lines[1], `6 apps · ${(room.apps.reduce((sum, app) => sum + (app.memoryBytes ?? 0), 0) / 1024 ** 3).toFixed(1)} GB`)
for (const title of ["Billing webhooks", "Set up api", "Payments queue", "Retry budget", "mako", "Checkout for a new Thread"]) assert.ok(lines.includes(title), `a row for ${title}`)
assert.ok(lines.includes("api · api, worker · up 26 min · used 14 min ago"), "a running Thread's project, processes, up time and last use")
assert.ok(lines.includes("api · waiting for memory for 3 min"))
assert.ok(lines.includes("api · crashed · used 28 min ago"))
assert.ok(lines.includes("api · installing ahead · up under a minute"), "a spare checkout installing ahead of any Thread")
assert.ok(lines.includes("812 MB") && lines.includes("1.2 GB"))
assert.deepEqual(lines.slice(-3), ["api: about 12 at once", "mako: learning its size, 1 of 3 runs", "Memory pressure normal · 9.8 GB free of 36.0 GB"])
assert.equal(fitLine(room.fits[0]!).tip.replace(/\u00a0/g, " "), "Each copy of api's app peaks around 860 MB, the median of its last 7 runs. With the memory free now, about 12 fit at once, counting the 1 running.")
assert.equal(fitLine({ root: "/r", name: "box", estimate: { kind: "containers" } }).text, "box: uses containers")
assert.equal(roomMemory({ ...room.apps[0]!, containers: true }), "812\u00a0MB+", "memory with containers outside it reads as at least")

const empty = text(renderToStaticMarkup(<RoomList room={{ ...room, apps: [], fits: [] }} />))
assert.deepEqual(empty, ["Room", "No apps running on this Mac", "Memory pressure normal · 9.8 GB free of 36.0 GB"])

// Stopping asks first for another Thread's or folder's app, never for the one in view or a spare's install.
const inView = room.apps[0]!
assert.deepEqual(othersAmong(room.apps, inView.checkout).map((app) => app.app), room.apps.filter((app) => app !== inView && app.kind !== "spare").map((app) => app.app))
const focused = text(renderToStaticMarkup(
  <WorkspaceFocusContext.Provider value={{ cwd: inView.checkout, identity: "none", ready: true }}>
    <RoomList room={room} />
  </WorkspaceFocusContext.Provider>,
))
assert.deepEqual(focused, lines, "the row in view reads the same")
const handed = { ...room.apps.at(-1)!, thread: { id: "t", title: "Fix login" } }
assert.equal(roomTitle(handed), "Fix login")
assert.match(roomDetail(handed, now), /installing, from before this Thread took the checkout/)

console.log("room view: rows with project, what runs, memory, up time and last use, waiting and crashed, spares installing ahead or handed to a Thread, each project's fit, the memory line, empty, and who stopping asks about")
