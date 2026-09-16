import assert from "node:assert/strict"
import {
  capabilityToken,
  hasReferences,
  mentionAt,
  replaceMention,
  tokenize,
} from "../src/lib/mentions.ts"
import {
  capabilityCatalog,
  isMakoServerName,
  mcpItems,
  skillItems,
} from "../src/lib/composer-capabilities.ts"
import {
  mcpTransportsFor,
  projectedMcpServers,
  reachableMcpServers,
} from "../electron/contracts/mcp-reach.ts"
import type {
  McpRegistrySnapshot,
  McpServerRecord,
  SkillRecord,
  SkillRegistrySnapshot,
} from "../electron/shared.ts"

/* Tokens ------------------------------------------------------------------ */

assert.deepEqual(tokenize("$unslop please"), [
  { kind: "skill", name: "unslop", raw: "$unslop" },
  { kind: "text", text: " please" },
])
assert.deepEqual(tokenize("use $mcp:example-browser here"), [
  { kind: "text", text: "use " },
  { kind: "mcp", name: "example-browser", raw: "$mcp:example-browser" },
  { kind: "text", text: " here" },
])
assert.deepEqual(
  tokenize("use $grilling, then $mcp:github. Done $5)."),
  [
    { kind: "text", text: "use " },
    { kind: "skill", name: "grilling", raw: "$grilling" },
    { kind: "text", text: ", then " },
    { kind: "mcp", name: "github", raw: "$mcp:github" },
    { kind: "text", text: ". Done " },
    { kind: "skill", name: "5", raw: "$5" },
    { kind: "text", text: ")." },
  ],
  "sentence punctuation after a capability token stays prose"
)
assert.deepEqual(tokenize("costs $."), [{ kind: "text", text: "costs $." }], "a sigil with nothing left after the trim is prose")
assert.deepEqual(tokenize("/frontend-design make it sing"), [
  { kind: "skill", name: "frontend-design", raw: "/frontend-design" },
  { kind: "text", text: " make it sing" },
])
assert.deepEqual(tokenize("/mcp:mako-backend list skills"), [
  { kind: "mcp", name: "mako-backend", raw: "/mcp:mako-backend" },
  { kind: "text", text: " list skills" },
])
assert.deepEqual(tokenize("/frontend-design"), [
  { kind: "skill", name: "frontend-design", raw: "/frontend-design" },
])
assert.deepEqual(
  tokenize("/Users/me/repo/file.ts is broken"),
  [{ kind: "text", text: "/Users/me/repo/file.ts is broken" }],
  "a leading path is prose, not a skill"
)
assert.deepEqual(tokenize("/ alone"), [{ kind: "text", text: "/ alone" }])
assert.deepEqual(
  tokenize("see /unslop later"),
  [{ kind: "text", text: "see /unslop later" }],
  "a slash invocation only counts at the very start"
)
assert.deepEqual(
  tokenize("/unslop later", false),
  [{ kind: "text", text: "/unslop later" }],
  "a slice that does not start the draft never opens with an invocation"
)
assert.deepEqual(tokenize("/unslop @src/a.ts $mcp:x"), [
  { kind: "skill", name: "unslop", raw: "/unslop" },
  { kind: "text", text: " " },
  { kind: "file", path: "src/a.ts", raw: "@src/a.ts" },
  { kind: "text", text: " " },
  { kind: "mcp", name: "x", raw: "$mcp:x" },
])
assert.equal(hasReferences("/unslop"), true)
assert.equal(hasReferences("plain"), false)
assert.equal(hasReferences("$5 budget"), true, "the tokenizer is permissive; chips decide")

assert.equal(capabilityToken("$", "skill", "unslop"), "$unslop")
assert.equal(capabilityToken("/", "skill", "unslop"), "/unslop")
assert.equal(capabilityToken("$", "mcp", "mako-backend"), "$mcp:mako-backend")
assert.equal(capabilityToken("/", "mcp", "mako-backend"), "/mcp:mako-backend")

/* Mentions at the caret --------------------------------------------------- */

assert.deepEqual(mentionAt("/", 1), { sigil: "/", query: "", start: 0, end: 1 })
assert.deepEqual(mentionAt("/fro", 4), { sigil: "/", query: "fro", start: 0, end: 4 })
assert.equal(mentionAt("/fro", 2)?.query, "f", "the query ends at the caret")
assert.equal(mentionAt("fix /this", 9), null, "a slash mid-sentence is prose")
assert.equal(mentionAt("/unslop now", 11), null, "after the token the menu is closed")
assert.deepEqual(mentionAt("do $uns", 7), { sigil: "$", query: "uns", start: 3, end: 7 })
assert.equal(mentionAt("cost$5", 6), null, "a sigil needs a word boundary")
assert.deepEqual(replaceMention("/fro", { sigil: "/", query: "fro", start: 0, end: 4 }, "/frontend-design"), {
  text: "/frontend-design ",
  caret: 17,
})

/* Reach ------------------------------------------------------------------- */

function server(
  name: string,
  origins: Array<[provider: string, scope: McpServerRecord["origins"][number]["scope"]]>,
  extra: Partial<McpServerRecord> = {}
): McpServerRecord {
  return {
    id: name,
    name,
    transport: "stdio",
    command: "npx",
    args: ["-y", name],
    envNames: [],
    headerNames: [],
    portable: true,
    origins: origins.map(([provider, scope]) => ({
      provider,
      account: "default",
      scope,
      provenance: `${provider}:${scope}`,
    })),
    ...extra,
  }
}

const mcpSnapshot: McpRegistrySnapshot = {
  cwd: "/repo",
  generatedAt: 0,
  providers: [],
  servers: [
    server("mako-control", [["mako", "managed"]]),
    server("mako-backend", [["mako", "managed"]], { transport: "http", url: "https://mako.example/api/mcp", portable: false }),
    server("blocked-managed", [["mako", "managed"]], { blockReason: "Dependency is not installed" }),
    server("github", [["codex", "user"]]),
    server("linear", [["claude", "workspace"]]),
    server("secretive", [["codex", "user"]], { portable: false }),
    server("drifted", [["codex", "user"], ["claude", "user"]], { conflict: "drift" }),
    server("gone", [["claude", "user"]], { availability: "unavailable" }),
    server("events", [["cursor", "user"]], { transport: "sse", url: "https://events.example/sse" }),
  ],
}

const projectedForClaude = projectedMcpServers(mcpSnapshot, "claude", ["stdio", "http"]).map((entry) => entry.name)
assert.deepEqual(
  projectedForClaude,
  ["mako-control", "mako-backend", "github"],
  "projection adds managed runtime servers and other providers' portable ones only"
)
const reachableForClaude = reachableMcpServers(mcpSnapshot, "claude", ["stdio", "http"]).map((entry) => entry.name)
assert.deepEqual(
  reachableForClaude,
  ["mako-control", "mako-backend", "github", "linear", "drifted"],
  "reach is the provider's own servers plus the projection"
)
assert.ok(!reachableForClaude.includes("gone"), "an unavailable native server is not reachable")
assert.ok(!reachableForClaude.includes("secretive"), "a non-portable server never crosses providers")
assert.ok(!reachableForClaude.includes("blocked-managed"), "a blocked managed server is not reachable")
assert.ok(!reachableForClaude.includes("events"), "a transport the provider cannot open is skipped")
assert.ok(
  reachableMcpServers(mcpSnapshot, "cursor", ["stdio", "http", "sse"]).map((entry) => entry.name).includes("events"),
  "the provider's own sse server reaches it"
)
assert.deepEqual(
  projectedMcpServers(mcpSnapshot, "codex", ["stdio", "http"]).map((entry) => entry.name),
  ["mako-control", "mako-backend", "linear"],
  "codex loads github and secretive natively, so neither is projected twice"
)

/* Catalog ----------------------------------------------------------------- */

function skill(name: string, origins: Array<[provider: string, scope: "user" | "workspace"]>, extra: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: name,
    name,
    description: `${name} description`,
    hash: name,
    bytes: 1,
    files: 1,
    portable: true,
    origins: origins.map(([provider, scope]) => ({ provider, account: "default", scope, provenance: `${provider}:${scope}/${name}`, hash: name })),
    ...extra,
  }
}

const skillsSnapshot: SkillRegistrySnapshot = {
  cwd: "/repo",
  generatedAt: 0,
  providers: [],
  skills: [
    skill("apple-design", [["agents", "user"], ["claude", "user"]]),
    skill("blast-radius", [["claude", "user"], ["codex", "user"]]),
    skill("frontend-design", [["agents", "user"]]),
    skill("hyperframes", [["cursor", "user"]]),
    skill("repo-only", [["claude", "workspace"]]),
    skill("broken", [["claude", "user"]], { portable: false, blockReason: "contains symbolic links" }),
  ],
}

const claudeSkills = skillItems(skillsSnapshot, "claude")
assert.deepEqual(
  claudeSkills.items.map((item) => [item.name, item.delivery?.kind, item.from ?? null, item.badge ?? null, item.blocked ?? null]),
  [
    ["apple-design", "native", null, null, null],
    ["blast-radius", "native", null, null, null],
    ["repo-only", "native", null, "project", null],
    ["broken", "native", null, null, "contains symbolic links"],
    ["frontend-design", "handover", "agents", null, null],
    ["hyperframes", "handover", "cursor", null, null],
  ],
  "own skills lead; universal and foreign copies are handed over, each naming its source"
)
assert.equal(claudeSkills.foreign, 1, "only another provider's skill counts as foreign; the universal root is nobody's")
assert.deepEqual(
  skillItems(skillsSnapshot, "grok").items.map((item) => [item.name, item.delivery?.kind]),
  [
    ["apple-design", "handover"],
    ["blast-radius", "handover"],
    ["frontend-design", "handover"],
    ["hyperframes", "handover"],
    ["repo-only", "handover"],
    ["broken", "handover"],
  ],
  "a provider with no roots is offered everything, all of it handed over"
)
const universalReader: SkillRegistrySnapshot = {
  ...skillsSnapshot,
  providers: [{ id: "grok", label: "Grok", account: "default", available: true, readsUniversalRoot: true }],
}
assert.deepEqual(
  skillItems(universalReader, "grok").items.filter((item) => item.delivery?.kind === "native").map((item) => item.name),
  ["apple-design", "frontend-design"],
  "a provider verified to read .agents/skills loads those itself"
)
assert.equal(
  skillItems(skillsSnapshot, "cursor").items.find((item) => item.name === "repo-only")?.delivery?.path,
  "claude:workspace/repo-only",
  "a handover prefers the project copy"
)
assert.equal(
  skillItems(skillsSnapshot, "codex").items.find((item) => item.name === "apple-design")?.from,
  "agents",
  "a handover prefers the universal copy over another provider's"
)
const manual: SkillRegistrySnapshot = { ...skillsSnapshot, skills: [skill("wait-what", [["agents", "user"]], { manual: true })] }
assert.equal(skillItems(manual, "cursor").items[0]?.badge, "manual", "a skill only the user may invoke says so")

assert.deepEqual(mcpTransportsFor("sdk"), ["stdio", "http"])
assert.deepEqual(mcpTransportsFor("app-server"), ["stdio", "http"])
assert.deepEqual(mcpTransportsFor("acp"), ["stdio", "http", "sse"])
assert.deepEqual(mcpTransportsFor(undefined), ["stdio", "http", "sse"], "unknown drivers read permissively")

const claudeServers = mcpItems(mcpSnapshot, "claude", mcpTransportsFor("sdk"))
assert.deepEqual(
  claudeServers.map((item) => [item.name, item.builtIn, item.badge ?? null, item.from ?? null]),
  [
    ["mako-backend", true, "built in", null],
    ["mako-control", true, "built in", null],
    ["mako-conversations", true, "built in", null],
    ["drifted", false, null, null],
    ["github", false, null, "codex"],
    ["linear", false, "project", null],
  ],
  "built-ins lead, then the rest alphabetically with provenance"
)
assert.equal(claudeServers.find((item) => item.name === "mako-backend")?.description, "Mako skills, integrations, and Slack")
assert.equal(claudeServers.find((item) => item.name === "github")?.description, "npx -y github")
assert.ok(isMakoServerName("mako-conversations"))
assert.ok(!isMakoServerName("github"))

const CLAUDE = mcpTransportsFor("sdk")
assert.ok(
  mcpItems(mcpSnapshot, "cursor", mcpTransportsFor("acp")).some((item) => item.name === "events" && item.from === "cursor") === false,
  "a provider's own server carries no provenance"
)
assert.ok(mcpItems(mcpSnapshot, "grok", mcpTransportsFor("acp")).some((item) => item.name === "events" && item.from === "cursor"))
const browse = capabilityCatalog(skillsSnapshot, mcpSnapshot, "claude", CLAUDE, "")
assert.deepEqual(browse.groups.map((group) => [group.label, group.matches.length, group.total]), [["Skills", 6, 6], ["MCP servers", 6, 6]])
const many: SkillRegistrySnapshot = { ...skillsSnapshot, skills: Array.from({ length: 9 }, (_, at) => skill(`skill-${at}`, [["agents", "user"]])) }
const capped = capabilityCatalog(many, mcpSnapshot, "claude", CLAUDE, "")
assert.deepEqual([capped.groups[0]?.matches.length, capped.groups[0]?.total], [6, 9], "browsing caps the list but reports the whole")
assert.equal(capabilityCatalog(many, mcpSnapshot, "claude", CLAUDE, "skill-8").groups[0]?.matches[0]?.item.name, "skill-8", "typing reaches past the cap")
assert.equal(browse.foreign, 1)

const search = capabilityCatalog(skillsSnapshot, mcpSnapshot, "claude", CLAUDE, "mako")
assert.deepEqual(search.groups.map((group) => group.label), ["MCP servers"], "an empty group is dropped")
assert.deepEqual(
  search.groups[0]?.matches.map((match) => match.item.name),
  ["mako-backend", "mako-control", "mako-conversations"]
)
assert.deepEqual(search.groups[0]?.matches[0]?.indices, [0, 1, 2, 3], "name hits carry glyph positions for highlighting")

const byDescription = capabilityCatalog(skillsSnapshot, mcpSnapshot, "claude", CLAUDE, "slack")
assert.deepEqual(byDescription.groups[0]?.matches.map((match) => [match.item.name, match.indices]), [["mako-backend", []]], "a description hit lists without highlighting")

const skillsFirst: SkillRegistrySnapshot = { ...skillsSnapshot, skills: [...skillsSnapshot.skills, skill("browser-tips", [["agents", "user"]], { description: "Notes on mako-control sessions" })] }
assert.deepEqual(
  capabilityCatalog(skillsFirst, mcpSnapshot, "claude", CLAUDE, "mako-c").groups.map((group) => group.label),
  ["MCP servers", "Skills"],
  "a name hit leads a description hit across groups"
)
assert.deepEqual(
  capabilityCatalog(skillsFirst, mcpSnapshot, "claude", CLAUDE, "mcp:mako-control").groups.map((group) => [group.label, group.matches.map((match) => match.item.name)]),
  [["MCP servers", ["mako-control"]]],
  "an mcp: prefix narrows to servers and matches the remainder"
)
const fuzzyHit = capabilityCatalog(skillsSnapshot, mcpSnapshot, "claude", CLAUDE, "fd")
assert.equal(fuzzyHit.groups[0]?.matches[0]?.item.name, "frontend-design")

assert.deepEqual(capabilityCatalog(null, null, "claude", CLAUDE, "").groups.map((group) => [group.label, group.matches.map((match) => match.item.name)]), [["MCP servers", ["mako-conversations"]]], "before discovery only the launch-attached conversation tools are known")
assert.equal(capabilityCatalog(skillsSnapshot, mcpSnapshot, "claude", CLAUDE, "zzzz").groups.length, 0)

console.log("composer capabilities ok")
