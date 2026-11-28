import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { damerau, matchField, parseQuery, prepare, TIER } from "../src/lib/palette-rank"
import { fieldsOf, searchPalette, flatRows, type PaletteCategory, type PaletteItem, type PaletteSection } from "../src/components/palette/palette-search"
import { memoryBoost, rememberPick, resetPaletteMemory } from "../src/state/palette-memory"

/*
 * The palette's ranking, on rows shaped like a real window's: the desk's commands, Settings' sections, a few
 * projects, and Threads with the titles people give them. Each case is a query someone types and what they meant;
 * then 5,000 Threads, timed.
 */

const NOW = Date.parse("2026-11-28T12:00:00Z")
const HOUR = 3_600_000

function command(id: string, title: string, keywords?: string, suggested?: number): PaletteItem {
  return { id: `command:${id}`, group: "actions", title, fields: fieldsOf(title, keywords), primary: 1, icon: { kind: "glyph", name: "action" }, ...(suggested !== undefined && { suggested }), run: () => {} }
}
function setting(id: string, title: string, keywords: string[]): PaletteItem {
  return { id: `settings:${id}`, group: "settings", title, fields: fieldsOf(title, ...keywords), primary: 1, icon: { kind: "glyph", name: "setting" }, queryOnly: true, run: () => {} }
}
function thread(id: string, title: string, project: string, harness: string, ageHours: number, extra: Partial<PaletteItem> = {}): PaletteItem {
  return { id: `thread:${id}`, group: "threads", title, fields: fieldsOf(title, project, harness), primary: 1, meta: `${project} · ${harness}`, at: NOW - ageHours * HOUR, icon: { kind: "thread", harness, state: "idle" }, project: `/Users/you/${project}`, run: () => {}, ...extra }
}
function model(name: string, provider: string): PaletteItem {
  return { id: `model:${provider}/${name}`, group: "models", title: name, fields: fieldsOf(name, provider), primary: 1, icon: { kind: "glyph", name: "model" }, queryOnly: true, run: () => {} }
}
function project(name: string, ageHours: number): PaletteItem {
  return { id: `project:/Users/you/${name}`, group: "projects", title: name, fields: fieldsOf(name, `/Users/you/${name}`), primary: 1, at: NOW - ageHours * HOUR, icon: { kind: "glyph", name: "project" }, project: `/Users/you/${name}`, scope: { kind: "project", path: `/Users/you/${name}`, name }, run: () => {} }
}

const COMMANDS = [
  command("session.new", "New thread", "start create", 0),
  command("apex.new", "New Apex", "lead orchestrate team owner area", 1),
  command("workspace.open", "Open project…", "project folder open clone github repository", 2),
  command("model.pick", "Switch model…", undefined, 3),
  command("view.search", "Search everything…", undefined, 4),
  command("attention.next", "Open the Inbox", "inbox needs you approvals questions next attention", 5),
  command("view.automations", "Automations", "automation schedule cron trigger recurring run proposal", 6),
  command("view.toggle-rail", "Toggle the session list"),
  command("view.toggle-companion", "Toggle the right sidebar"),
  command("view.toggle-theme", "Toggle light and dark"),
  command("view.terminal", "Toggle terminal dock"),
  command("tab.close", "Close active tab"),
  command("app.restart", "Restart Mako", "relaunch reload engine rebuild host"),
  command("view.reset-zoom", "Reset zoom"),
  command("session.compact", "Compact the conversation"),
]
const SETTINGS = [
  setting("appearance", "Appearance", ["theme", "dark", "light", "auto", "system", "color"]),
  setting("agents", "Agents", ["harness", "sign in", "claude", "codex", "cursor"]),
  setting("keyboard", "Keyboard shortcuts", ["keys", "bindings", "chord"]),
  setting("git", "Git", ["commit", "messages", "branch", "pull requests"]),
  setting("notifications", "Notifications", ["sound", "badge", "quiet"]),
]
const MODELS = [model("Claude Opus 5.5", "anthropic"), model("GPT-6 Sol", "openai"), model("Grok 5", "xai"), model("Composer 2", "cursor")]
const PROJECTS = [project("mako", 1), project("api", 30), project("site", 200)]
const THREADS = [
  thread("disk", "Where the disk space went", "makomono", "claude", 3, { urgency: 1, icon: { kind: "thread", harness: "claude", state: "working" } }),
  thread("oneleet", "I investigated Oneleet's SOC 2 findings", "flage", "codex", 26),
  thread("inbox", "Inbox redesign: rows, density, keyboard", "mako", "claude", 0.2),
  thread("apikeys", "API keys rotation for the gateway", "site", "codex", 50),
  thread("api-misc", "Fix flaky test in auth middleware", "api", "cursor", 1),
  thread("settings-crash", "Settings crashes when ⌘K pressed", "mako", "claude", 0.5, { urgency: 0, icon: { kind: "thread", harness: "claude", state: "needs" } }),
  thread("newthread", "New thread ideas for onboarding", "mako", "grok", 400),
  thread("cafe", "Café menu scraper", "site", "opencode", 72),
  thread("palette-old", "Command palette ranking notes", "mako", "claude", 900),
  thread("palette-new", "Command palette ranking", "mako", "codex", 2),
]
const ITEMS: PaletteItem[] = [...THREADS, ...PROJECTS, ...COMMANDS, ...SETTINGS, ...MODELS]

function search(query: string, category: PaletteCategory = "all", items: readonly PaletteItem[] = ITEMS): PaletteSection[] {
  return searchPalette({ items, query, category, now: NOW, boost: memoryBoost })
}
function ids(query: string, category: PaletteCategory = "all"): string[] {
  return flatRows(search(query, category)).map((row) => row.item.id)
}
function first(query: string, category: PaletteCategory = "all"): string | undefined {
  return ids(query, category)[0]
}
function groups(query: string): string[] {
  return search(query).map((section) => section.group)
}

// Tiers: exact over prefix over a word over a substring over scattered letters over a typo.
{
  const field = prepare("Toggle light and dark")
  assert.equal(matchField(parseQuery("toggle light and dark"), field, true)?.tier, TIER.exact)
  assert.equal(matchField(parseQuery("togg"), field, true)?.tier, TIER.prefix)
  assert.equal(matchField(parseQuery("light"), field, true)?.tier, TIER.word)
  assert.equal(matchField(parseQuery("ight"), field, true)?.tier, TIER.substring)
  assert.equal(matchField(parseQuery("tld"), field, true)?.tier, TIER.fuzzy)
  assert.equal(matchField(parseQuery("toglle"), field, true)?.tier, TIER.typo)
  assert.equal(matchField(parseQuery("ight"), field, false), null, "a secondary field never matches inside a word")
  assert.deepEqual(matchField(parseQuery("light toggle"), field, true)?.indices, [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11], "words in any order light where each starts")
  assert.deepEqual(matchField(parseQuery("nt"), prepare("New thread"), true)?.indices, [0, 4], "scattered letters prefer word starts")
  assert.equal(matchField(parseQuery("cafe"), prepare("Café menu scraper"), true)?.tier, TIER.prefix, "accents fold")
  assert.equal(matchField(parseQuery("zzz"), field, true), null)
  assert.equal(damerau("setings", "settings", 1), 1)
  assert.equal(damerau("abcdef", "badcfe", 1), 2, "beyond the limit stops early")
  console.log("PASS: tiers, word order, word-start letters, accents, typos")
}

// What people type, and what they meant.
assert.equal(first("new thread"), "command:session.new", "New thread, the command, before a Thread titled New thread ideas")
assert.ok(ids("new thread").includes("thread:newthread"), "and that Thread is still found")
assert.equal(first("disk"), "thread:disk", "disk finds the Thread about the disk")
assert.equal(first("inbox"), "thread:inbox", "inbox: the Thread titled Inbox… starts with it, the command has it as a word")
assert.ok(ids("inbox").indexOf("command:attention.next") < 4, "Open the Inbox is near the top")
assert.equal(first("theme"), "settings:appearance", "theme finds Appearance by what it's known by")
assert.equal(first("setings", "actions"), undefined, "no section is called setings")
assert.equal(first("keyboard"), "settings:keyboard")
assert.equal(first("light toggle"), "command:view.toggle-theme", "words in either order")
assert.equal(first("opus"), "model:anthropic/Claude Opus 5.5", "a model by a word of its name")
assert.ok(!ids("model").some((id) => id.startsWith("model:")), "the section's label is never searched: model doesn't list every model")
assert.ok(ids("model").includes("command:model.pick"), "but Switch model… matches it")
assert.equal(first("cafe"), "thread:cafe", "accents fold")
assert.equal(first("restrat"), "command:app.restart", "a slip of the fingers (one transposition) still finds Restart")
console.log("PASS: commands, Threads, settings and models by what people type")

// A project's name is a Thread's secondary field: it never outranks a Thread titled with the word.
{
  const order = ids("api")
  assert.ok(order.indexOf("thread:apikeys") < order.indexOf("thread:api-misc"), `API keys… (title) before a Thread only filed under api: ${order.join(", ")}`)
  assert.equal(search("api").find((section) => section.group === "projects")?.rows[0]?.item.id, "project:/Users/you/api", "the project itself is listed")
}
// Recency orders rows within a tier, never across one.
{
  const order = ids("command palette ranking")
  assert.equal(order[0], "thread:palette-new", "the exact title, recent, first")
  const both = ids("palette ranking")
  assert.ok(both.indexOf("thread:palette-new") < both.indexOf("thread:palette-old"), "the newer of two equal matches first")
  const old = thread("old-exact", "Gateway", "site", "codex", 5000)
  const fresh = thread("fresh-sub", "The new gateway service", "site", "codex", 0.1)
  const ranked = flatRows(search("gateway", "threads", [old, fresh])).map((row) => row.item.id)
  assert.deepEqual(ranked, ["thread:old-exact", "thread:fresh-sub"], "an exact title from months ago beats a word in a title from minutes ago")
}
console.log("PASS: secondary fields count half, recency orders within a tier only")

// What was picked for a query comes first for it, and for three letters or more of it, next time.
{
  resetPaletteMemory()
  const before = ids("pal ran")
  assert.equal(before[0], "thread:palette-new")
  rememberPick("thread:palette-old", "pal ran", NOW - HOUR)
  assert.equal(memoryBoost("thread:palette-old", "pal ran", NOW), Math.min(1, 0.5 + 0.2), "a pick an hour ago: .5 for the query, .2 for the open")
  const after = searchPalette({ items: ITEMS, query: "pal ran", category: "all", now: NOW, boost: (id, query) => memoryBoost(id, query, NOW) })
  assert.equal(flatRows(after)[0]?.item.id, "thread:palette-old", "picked for this query, it leads")
  assert.equal(memoryBoost("thread:palette-old", "pal", NOW) >= 0.5, true, "three letters of the query count")
  assert.ok(memoryBoost("thread:palette-old", "pa", NOW) < 0.5, "two letters don't")
  resetPaletteMemory()
}
console.log("PASS: picks lift a row for its query, opens lift it a little")

// Nothing typed: what needs you, then the Recent Threads by state then time, then the suggested actions in order.
{
  const empty = search("")
  assert.deepEqual(empty.map((section) => section.group).slice(0, 3), ["threads", "actions", "projects"])
  const recent = empty.find((section) => section.group === "threads")?.rows.map((row) => row.item.id) ?? []
  assert.deepEqual(recent.slice(0, 3), ["thread:settings-crash", "thread:disk", "thread:inbox"], "needs you, then working, then the newest")
  assert.equal(recent.length, 6, "six recent Threads")
  const actions = empty.find((section) => section.group === "actions")?.rows.map((row) => row.item.id) ?? []
  assert.deepEqual(actions.slice(0, 4), ["command:session.new", "command:apex.new", "command:workspace.open", "command:model.pick"])
  assert.ok(!empty.some((section) => section.group === "settings" || section.group === "models"), "settings and models wait for a query")
  assert.deepEqual(groups("").includes("threads"), true)
}
console.log("PASS: with nothing typed, needs you and working Threads lead, then suggested actions")

// Prefixes and tabs narrow; under All each group shows a few, its tab the rest.
{
  assert.ok(ids(">toggle").every((id) => id.startsWith("command:") || id.startsWith("settings:") || id.startsWith("model:")), "> is actions")
  assert.ok(ids("@mako").every((id) => id.startsWith("thread:")), "@ is Threads")
  assert.ok(ids("toggle", "threads").every((id) => id.startsWith("thread:")))
  const many = Array.from({ length: 30 }, (_, index) => thread(`bulk-${index}`, `Gateway retries part ${index}`, "site", "codex", index))
  const crowd = [...many, command("gateway.open", "Open the gateway logs"), setting("gateway", "Gateway", ["gateway"]), project("gateway", 5)]
  const all = searchPalette({ items: crowd, query: "gateway", category: "all", now: NOW })
  const listed = all.find((section) => section.group === "threads")
  assert.equal(listed?.rows.length, 8, "eight Threads under All beside other groups")
  assert.equal(listed?.more, 22, "and how many more")
  assert.equal(searchPalette({ items: many, query: "gateway", category: "all", now: NOW })[0]?.rows.length, 12, "twelve when Threads are all that matched")
  assert.equal(searchPalette({ items: many, query: "gateway", category: "threads", now: NOW })[0]?.rows.length, 30, "all of them in Threads")
  const scoped = searchPalette({ items: ITEMS, query: "", category: "all", scope: { kind: "project", path: "/Users/you/mako", name: "mako" }, now: NOW })
  assert.ok(flatRows(scoped).every((row) => row.item.project === "/Users/you/mako"), "a project's scope lists only its rows")
}
console.log("PASS: > and @ narrow, tabs show every match, a project scope holds its rows")

// Typing a word letter by letter: once a group shows, it doesn't trade places with another, and rows shown keep their order.
{
  const steps = ["c", "co", "com", "comm", "comma", "comman", "command"]
  let previous: string[] | undefined
  let previousGroups: string[] | undefined
  for (const step of steps) {
    const order = ids(step).filter((id) => id.startsWith("thread:palette"))
    if (previous && previous.length === order.length) assert.deepEqual(order, previous, `the palette Threads keep their order at "${step}"`)
    const shown = groups(step)
    if (previousGroups && step.length >= 4) assert.deepEqual(shown.filter((group) => previousGroups?.includes(group)), previousGroups.filter((group) => shown.includes(group)), `groups keep their order at "${step}"`)
    previous = order
    previousGroups = shown
  }
}
console.log("PASS: rows and groups hold their places as a word is typed")

// 5,000 Threads: index once, then each keystroke.
{
  const words = ["gateway", "retry", "billing", "auth", "palette", "inbox", "migrate", "postgres", "flaky", "onboarding", "deploy", "cache", "render", "worker", "webhook", "export", "sidebar", "phone", "ipad", "release"]
  const projects = ["mako", "api", "site", "web", "infra", "mobile", "billing", "docs"]
  const harnesses = ["claude", "codex", "cursor", "grok", "opencode", "devin"]
  const titles = Array.from({ length: 5000 }, (_, index) => {
    const a = words[index % words.length]!
    const b = words[(index * 7 + 3) % words.length]!
    const c = words[(index * 13 + 5) % words.length]!
    return `${a[0]!.toUpperCase()}${a.slice(1)} ${b} when ${c} fails (#${index})`
  })
  const built = performance.now()
  const big: PaletteItem[] = titles.map((title, index) => thread(`big-${index}`, title, projects[index % projects.length]!, harnesses[index % harnesses.length]!, index / 10))
  const buildMs = performance.now() - built
  const all = [...big, ...PROJECTS, ...COMMANDS, ...SETTINGS, ...MODELS]
  const queries = ["g", "ga", "gat", "gate", "gatew", "gateway", "gateway auth", "auth gateway", "fla", "flaky postgres", "zzzz", "setings", "#42", "ipad sidebar", ""]
  const times: number[] = []
  for (let round = 0; round < 3; round += 1) {
    for (const query of queries) {
      const start = performance.now()
      const sections = search(query, "all", all)
      times.push(performance.now() - start)
      if (query === "gateway auth") assert.ok((sections[0]?.rows.length ?? 0) > 0)
    }
  }
  const sorted = [...times].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  const max = sorted.at(-1)!
  console.log(`TIMING: 5,000 Threads indexed in ${buildMs.toFixed(1)} ms; a keystroke's search p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms over ${times.length}`)
  assert.ok(p95 < 16, `a keystroke over 5,000 Threads stays inside a frame (p95 ${p95.toFixed(2)} ms)`)
}
console.log("PASS: 5,000 Threads search inside a frame")
