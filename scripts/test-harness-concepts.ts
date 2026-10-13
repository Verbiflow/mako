import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import { z } from "zod"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { GENERATED_PATH, renderHarnessConcepts } from "./harness-concepts.ts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { readSources } from "@mako/host/tools/native-authoring"
import { AuthoringFiles, revisionOf } from "@mako/host/tools/authoring-files"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

/**
 * Holds each harness's concepts (packages/sessions/src/harnesses) to what the
 * installed harness was seen to do, and Mako's own reads and writes to the
 * concepts. Refresh a fixture with `npm run harness:self-report -- <harness>`.
 */

const Places = z.object({ via: z.string(), listed: z.array(z.string()), missing: z.array(z.string()) })
const Fixture = z.object({
  harness: z.string(),
  version: z.string(),
  on: z.string(),
  probed: z.number(),
  missing: z.array(z.string()),
  skills: Places.optional(),
  mcpConfig: Places.optional(),
})

const version = (text: string) => /\d+(?:\.\d+)+/.exec(text)?.[0]
/** A path the way concepts write it: `~/…` under the home, relative inside the project. */
const declared = (path: string, project: string) =>
  path.startsWith(`${project}/`) ? relative(project, path) : path.startsWith(`${homedir()}/`) ? `~/${relative(homedir(), path)}` : path

// The installed build has every name the concepts declare, and lists every place they say it reads.
for (const { harness, concepts } of VOCABULARIES) {
  const file = new URL(`./fixtures/native-vocabulary/${harness}-concepts.json`, import.meta.url)
  assert.ok(existsSync(file), `${harness} has no concepts fixture; run npm run harness:self-report -- ${harness}`)
  const fixture = Fixture.parse(JSON.parse(readFileSync(file, "utf8")))
  assert.equal(fixture.version, version(concepts.checked.version), `${harness}'s concepts were checked on ${concepts.checked.version}, its fixture on ${fixture.version}`)
  assert.deepEqual(fixture.missing, [], `${harness} ${fixture.version} lacks names its concepts declare`)
  assert.deepEqual(fixture.skills?.missing ?? [], [], `${harness} ${fixture.version} doesn't list skills from declared folders`)
  assert.deepEqual(fixture.mcpConfig?.missing ?? [], [], `${harness} ${fixture.version} doesn't list MCP servers from declared files`)

  const skills = providerHost.skillSources.get(harness)
  if (skills) {
    const account = { name: "default" }
    for (const root of [...skills.userRoots(account), skills.targetUserRoot(account)])
      assert.ok(concepts.skills.includes(declared(root, "/project")), `${harness}: Mako reads or writes skills in ${declared(root, "/project")}, which the harness doesn't read`)
    assert.ok(concepts.skills.includes(`${skills.workspaceFolder}/skills`), `${harness}: Mako reads project skills in ${skills.workspaceFolder}/skills, which the harness doesn't read`)
    if (skills.readsUniversalRoot)
      for (const root of ["~/.agents/skills", ".agents/skills"])
        assert.ok(fixture.skills?.listed.includes(root), `${harness} is declared to read ${root}, but ${fixture.skills?.via ?? "nothing it reports"} hasn't shown it`)
  }
  const mcp = providerHost.mcpSources.get(harness)
  if (mcp) {
    for (const path of [...mcp.userFiles({ name: "default" }), ...mcp.workspaceFiles("/project")])
      assert.ok(concepts.mcpConfig.includes(declared(path, "/project")), `${harness}: Mako reads MCP servers from ${declared(path, "/project")}, which the harness doesn't read`)
  }
}
console.log(`harness concepts: ${VOCABULARIES.length} harnesses match their installed builds, and Mako reads only where each harness does`)

// Mako's editors read and write only where the harness reads: every source of
// every family, and one new entry saved into each writable source of a
// throwaway home and project, then found where the concepts say.
const world = await realpath(await mkdtemp(join(tmpdir(), "mako-concepts-")))
try {
  const home = join(world, "home")
  const project = join(world, "project")
  await mkdir(project, { recursive: true })
  const places = (concepts: (typeof VOCABULARIES)[number]["concepts"]) => [
    ...("config" in concepts.hooks ? concepts.hooks.config : []),
    ...("folders" in concepts.commands ? concepts.commands.folders : []),
    ...concepts.mcpConfig,
  ]
  const within = (path: string, declared: readonly string[]) => declared.some((place) => path === place || path.startsWith(`${place}/`))
  const conceptual = (path: string) => path.startsWith(`${project}/`) ? relative(project, path) : path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path
  const files = new AuthoringFiles(join(world, "backups"))
  let written = 0
  for (const { harness, concepts } of VOCABULARIES) {
    for (const family of ["hooks", "commands", "mcp"] as const) {
      const capability = family === "mcp" ? providerHost.mcpEditing.get(harness) : providerHost[family].get(harness)
      if (!capability) continue
      const context = { cwd: project, home, env: { HOME: home } }
      for (const spec of await capability.sources(context)) {
        if (spec.scope === "managed" || spec.switches) continue
        assert.ok(within(conceptual(spec.path), places(concepts)), `${harness}: Mako reads ${family} from ${conceptual(spec.path)}, which the harness doesn't read`)
      }
      if (family === "mcp" || !capability.operations.create.supported) continue
      for (const source of await readSources(capability, context)) {
        if (!source.spec.writable.supported || source.spec.scope === "managed") continue
        const draft = capability.form === "hook"
          ? { kind: "hook" as const, event: capability.hooks?.events[0] ?? "", type: capability.hooks?.handlers[0]?.type ?? "command", run: "true" }
          : capability.form === "module" ? { kind: "module" as const, name: "probe", text: "export default {}\n" } : { kind: "command" as const, invocation: "probe", text: "Probe.\n" }
        if (source.spec.format !== "folder" && capability.form !== "hook") continue
        const edit = capability.change([source], { kind: "create", sourceId: source.spec.id, draft })
        await files.write(edit.root, edit.path, revisionOf(edit.before), edit.after, null)
        assert.ok(within(conceptual(edit.path), places(concepts)), `${harness}: Mako saves ${family} to ${conceptual(edit.path)}, which the harness doesn't read`)
        written += 1
      }
    }
  }
  assert.ok(written >= 12, `every writable hook and command source was written to, ${written} in all`)
} finally {
  await rm(world, { recursive: true, force: true })
}
console.log("harness concepts: Mako's hook, command and MCP editors read and save only where their harness reads")

assert.equal(readFileSync(GENERATED_PATH, "utf8"), renderHarnessConcepts(), "docs/harness-concepts.md is behind the declarations; run npm run harness:concepts")
console.log("harness concepts: docs/harness-concepts.md matches the declarations")
