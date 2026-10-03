import assert from "node:assert/strict"
import type { AppProbeView } from "../electron/contracts/thread-app.ts"

/**
 * The probe on the desk: each finding in sentences, paths from `~` and
 * never cut short, sections with nothing in them left out, and a look
 * with nothing to report saying so.
 */

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const { renderToStaticMarkup } = await import("react-dom/server")
const { ProbeReport } = await import("@/components/stage/app-probe")

const text = (view: AppProbeView) => renderToStaticMarkup(<ProbeReport view={view} />).replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").split("\n").map((line) => line.trim()).filter(Boolean)
const home = "/Users/you"
const empty: AppProbeView = {
  at: 0,
  home,
  running: true,
  upSince: 0,
  ports: { first: 20020, last: 20029 },
  listening: [],
  connectsTo: [],
  connectsOutside: { entries: [] },
  writing: { entries: [] },
  leftovers: [],
  changed: { entries: [] },
  changedBy: "history",
  registered: [],
  notes: [],
}

assert.deepEqual(text(empty), ["Nothing so far: no ports, connections, files, processes, changed folders or registrations outside this folder."])

const deep = "IndexedDB/http_localhost_20140.indexeddb.leveldb/000003.log"
const lines = text({
  ...empty,
  listening: [{ port: 20020, pid: 10, fixed: false }, { port: 9229, pid: 11, fixed: true }, { port: 61000, pid: 10, fixed: false }],
  connectsTo: [{ port: 5432, owner: "postgres (pid 812), which Mako didn't start" }],
  writing: { entries: [{ path: `${home}/Library/Application Support/Mako/host.lock`, pid: 11 }], more: 3 },
  leftovers: [{ pid: 12, command: "node esbuild --service", sure: true }, { pid: 13, command: "sleep 60", sure: false }],
  changed: {
    entries: [{ folder: `${home}/Library/Application Support/Mako`, paths: ["host.lock", deep], more: true, who: "pid 11 (Electron) has host.lock open for writing now." }],
  },
  changedBy: "times",
  registered: [{ kind: "launch-agent", name: "com.example.agent", detail: "It points into this app's checkout, data folder or app bundle, so it's the app's." }],
})
const after = (heading: string) => lines.slice(lines.indexOf(heading) + 1)

assert.deepEqual(after("Ports it listens on").slice(0, 9), [
  "Port 20020", "pid 10", "One of this Thread's ports, 20020 to 20029.",
  "Port 9229", "pid 11", "Outside this Thread's ports 20020 to 20029, so a second copy would fight over it.",
  "Port 61000", "pid 10", "Picked by the system, so a second copy gets another.",
])
assert.equal(after("Services on this Mac it uses")[2], "Listened on by postgres (pid 812), which Mako didn't start.")
assert.ok(!lines.includes("Connections off this Mac"), "a section with nothing in it is left out")
assert.deepEqual(after("Files it writes outside this folder").slice(1, 4), ["~/Library/Application Support/Mako/host.lock", "pid 11", "And 3 more files."])
assert.deepEqual(after("Left running").slice(1, 7), [
  "node esbuild --service", "pid 12", "It carries the mark Mako puts on everything it starts for this app, so it's the app's.",
  "sleep 60", "pid 13", "It works in this folder. Mako can't read its environment, so it may not be the app's.",
])
const changed = after("Changed since it started")
assert.match(changed[0]!, /Compared by modification times one or two levels down/)
assert.deepEqual(changed.slice(1, 6), ["~/Library/Application Support/Mako", "host.lock", deep, "And more that Mako didn't keep the names of.", "pid 11 (Electron) has host.lock open for writing now."])
assert.deepEqual(after("Registered with macOS").slice(1, 3), ["com.example.agent", "It points into this app's checkout, data folder or app bundle, so it's the app's."])
assert.ok(!lines.some((line) => /undefined|…/.test(line)))

console.log("app probe view: findings in sentences, paths from home in full, empty sections left out, and nothing found said so")
