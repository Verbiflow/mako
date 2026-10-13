import "./lib/scratch-git.mjs"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { join } from "node:path"
import { nativeAuthoring, type NativeAuthoring } from "@mako/host/tools/native-authoring"
import { AuthoringFiles } from "@mako/host/tools/authoring-files"
import type { ToolHarnesses } from "@mako/host/tools/harnesses"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { toolHarnesses } from "@mako/host/harnesses/tool-harnesses"
import { cursorProjectSlug } from "@mako/host/harnesses/cursor/authoring"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * A scratch home and project holding one harness's recorded config shapes
 * (`scripts/fixtures/native-authoring/<harness>`), with every harness's
 * authoring reading that home: the person's own configs are never read or
 * written. `@PROJECT@`, `@HOME@` and a `@SLUG@` folder are filled in for the
 * scratch paths; the project is a Git repository that Grok and Codex trust.
 */

export const FIXTURES = join(import.meta.dirname, "fixtures", "native-authoring")
const run = promisify(execFile)

export interface AuthoringWorld {
  root: string
  home: string
  project: string
  /** Where a fixture hook would leave a file if anything ran it. */
  marker: string
  backups: string
  harnesses: ToolHarnesses
  authoring: NativeAuthoring
  read(relative: string): Promise<string>
  cleanup(): Promise<void>
}

async function fill(folder: string, values: ReadonlyMap<string, string>): Promise<void> {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    let path = join(folder, entry.name)
    if (entry.name.includes("@SLUG@")) {
      const renamed = join(folder, entry.name.replace("@SLUG@", values.get("@SLUG@") ?? ""))
      await rename(path, renamed)
      path = renamed
    }
    if (entry.isDirectory()) await fill(path, values)
    else {
      let text = await readFile(path, "utf8")
      for (const [key, value] of values) text = text.replaceAll(key, value)
      await writeFile(path, text)
    }
  }
}

export async function authoringWorld(harness: string): Promise<AuthoringWorld> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-authoring-world-")))
  const home = join(root, "home")
  const project = join(root, "project")
  const marker = join(root, "marker")
  const backups = join(root, "backups")
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true }), mkdir(marker)])
  for (const part of ["home", "project"] as const) {
    const from = join(FIXTURES, harness, part)
    if (await stat(from).then(() => true, () => false)) await cp(from, part === "home" ? home : project, { recursive: true })
  }
  await mkdir(join(home, ".grok"), { recursive: true })
  await writeFile(join(home, ".grok", "trusted_folders.toml"), `[folders.${JSON.stringify(project)}]\ntrusted = true\ndecided_at = 1791868951\n`)
  await fill(root, new Map([["@PROJECT@", project], ["@HOME@", home], ["@SLUG@", cursorProjectSlug(project)]]))
  // A real repository: Grok finds a project's root, and reads its own hooks, only in one.
  await run("git", ["init", "-q", project])
  const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
  const harnesses: ToolHarnesses = {
    ...toolHarnesses(host),
    account: () => Promise.resolve({ env: { HOME: home, PATH: process.env.PATH, MAKO_FIXTURE_MARKER: marker }, account: { name: "default" } }),
  }
  return {
    root, home, project, marker, backups, harnesses,
    authoring: nativeAuthoring(harnesses, new AuthoringFiles(backups)),
    read: (relative) => readFile(join(root, relative), "utf8"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
