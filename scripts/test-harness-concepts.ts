import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import { z } from "zod"
import { providerHost } from "../electron/providers/index.ts"
import { GENERATED_PATH, renderHarnessConcepts } from "./harness-concepts.ts"

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

// Mako's editors write where the harness reads: one save into a throwaway project, then see where it landed.
const project = await realpath(await mkdtemp(join(tmpdir(), "mako-concepts-")))
try {
  for (const { harness, concepts } of VOCABULARIES) {
    const commands = providerHost.commands.get(harness)
    if (commands) {
      await commands.write(project, "probe", "Probe.\n", null)
      const folders = "folders" in concepts.commands ? concepts.commands.folders : []
      const written = (await readdir(project, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(project, join(entry.parentPath, entry.name)))
      for (const path of written)
        assert.ok(folders.some((folder) => path.startsWith(`${folder}/`)), `${harness}: Mako saves commands to ${path}, which the harness doesn't read`)
      await rm(join(project, written[0]!.split("/")[0]!), { recursive: true, force: true })
    }
    const hooks = providerHost.hooks.get(harness)
    if (hooks) {
      await hooks.write(project, "configuration", "{}", null)
      const config = "config" in concepts.hooks ? concepts.hooks.config : []
      const written = (await readdir(project, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => relative(project, join(entry.parentPath, entry.name)))
      for (const path of written) assert.ok(config.includes(path), `${harness}: Mako saves hooks to ${path}, which the harness doesn't read`)
      await rm(join(project, written[0]!.split("/")[0]!), { recursive: true, force: true })
    }
  }
} finally {
  await rm(project, { recursive: true, force: true })
}
console.log("harness concepts: Mako's command and hook editors save where their harness reads")

assert.equal(readFileSync(GENERATED_PATH, "utf8"), renderHarnessConcepts(), "docs/harness-concepts.md is behind the declarations; run npm run harness:concepts")
console.log("harness concepts: docs/harness-concepts.md matches the declarations")
