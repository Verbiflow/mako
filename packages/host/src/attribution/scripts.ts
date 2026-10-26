import { dirname, join } from "node:path"
import { z } from "zod"
import { scriptRuns, type ScriptRun } from "@mako/sessions/tool-effect-reading"

/*
 * What a command ran besides its own line: the script `python3 draw.py`
 * runs, the package script `npm run gen` runs, the Makefile rules `make`
 * follows, and what those run in turn. Their text names the files the
 * command writes as surely as an inline script's does (`spelled` in
 * `evidence.ts` reads both alike), so a turn that writes `draw.py` and runs
 * it owns the `tide.png` it draws. Each file is read as it was when the
 * command ran, or not at all (`ScriptReader`).
 */

/** Text a command ran, with the folders its relative names are read from: the script's own folder and the one it ran in. */
export interface RanText {
  text: string
  folders: string[]
}

/**
 * A file's text as it was when the command started: null when nothing is
 * there, undefined when that can't be known (changed since it started, too
 * large, not text, a link, or a name that holds secrets).
 */
export type ScriptReader = (path: string) => Promise<string | null | undefined>

/**
 * A script larger than this is left unread. Every script a session wrote in
 * a survey of 3,800 runs was under 31 KB; larger files are a repository's
 * test suites and bundles, whose text names the fixtures and inputs they
 * read far more than what they write.
 */
export const SCRIPT_LIMIT = 64 * 1024
/** How far one run leads to another: a command, the package script it runs, the file that runs, a script that file runs by a shell. */
const MAX_DEPTH = 3
/** Texts read for one command, at most. */
const MAX_TEXTS = 12
/** The Makefile names Make looks for, in its order. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"]
/** Folders a package script's `package.json` is looked for in, from the command's own up. */
const PACKAGE_LEVELS = 8

/** Every text `command` ran, read through `read`, in the order it ran them. */
export async function ranTexts(command: string, cwd: string | undefined, read: ScriptReader): Promise<RanText[]> {
  const out: RanText[] = []
  const seen = new Set<string>()
  const keep = (text: string, folders: readonly (string | undefined)[], key: string) => {
    if (seen.has(key) || out.length >= MAX_TEXTS) return false
    seen.add(key)
    out.push({ text, folders: [...new Set(folders.filter((folder): folder is string => folder !== undefined))] })
    return true
  }
  const visit = async (runs: readonly ScriptRun[], depth: number): Promise<void> => {
    for (const run of runs) {
      if (out.length >= MAX_TEXTS) return
      const next = await follow(run, read, keep)
      if (depth < MAX_DEPTH) for (const [line, folder] of next) await visit(scriptRuns(line, folder), depth + 1)
    }
  }
  await visit(scriptRuns(command, cwd), 1)
  return out
}

/** One run's text, kept, and the command lines in it to follow, each with the folder it runs in. */
async function follow(run: ScriptRun, read: ScriptReader, keep: (text: string, folders: readonly (string | undefined)[], key: string) => boolean): Promise<[string, string | undefined][]> {
  switch (run.kind) {
    case "file": {
      const text = await read(run.path)
      if (text === null || text === undefined) return []
      // A program run by its path is a script only by its first line, which also says whether a shell runs it.
      if (run.shell === undefined && !text.startsWith("#!")) return []
      const shell = run.shell ?? SHELL_LINE.test(text)
      if (!keep(text, [dirname(run.path), run.cwd], `file:${run.path}:${run.cwd}`)) return []
      return shell ? [[text, run.cwd]] : []
    }
    case "package": {
      const found = await packageScripts(run.cwd, read)
      if (!found) return []
      const names = run.manager === "npm" ? [`pre${run.script}`, run.script, `post${run.script}`] : [run.script]
      const lines: [string, string | undefined][] = []
      for (const name of names) {
        const line = found.scripts[name]
        if (line === undefined || !keep(line, [found.folder], `package:${found.folder}:${name}`)) continue
        lines.push([line, found.folder])
      }
      return lines
    }
    case "make": {
      const makefile = run.makefile ? { path: run.makefile, text: await read(run.makefile) } : await firstMakefile(run.cwd, read)
      const text = makefile?.text
      if (!makefile || text === null || text === undefined) return []
      const rules = makeRules(text, run.targets)
      if (!rules || !keep(rules.text, [run.cwd], `make:${makefile.path}:${run.targets.join(" ")}`)) return []
      return rules.recipes.map((line) => [line, run.cwd])
    }
  }
}

/** A first line that runs the file with a shell: `#!/bin/sh`, `#!/usr/bin/env bash`. */
const SHELL_LINE = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh(?:\s|$)/

/** What a `package.json` says of its scripts: each a command line by name. */
const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() })

/** The scripts of the package a command in `cwd` runs: the nearest `package.json` at or above it. */
async function packageScripts(cwd: string, read: ScriptReader): Promise<{ folder: string; scripts: Partial<Record<string, string>> } | undefined> {
  let folder = cwd
  for (let level = 0; level < PACKAGE_LEVELS; level++) {
    const text = await read(join(folder, "package.json"))
    if (text === undefined) return undefined
    if (text !== null) {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        return undefined
      }
      const parsed = PackageSchema.safeParse(json)
      return parsed.success && parsed.data.scripts ? { folder, scripts: parsed.data.scripts } : undefined
    }
    const up = dirname(folder)
    if (up === folder) return undefined
    folder = up
  }
  return undefined
}

async function firstMakefile(cwd: string, read: ScriptReader): Promise<{ path: string; text: string | null | undefined } | undefined> {
  for (const name of MAKEFILES) {
    const path = join(cwd, name)
    const text = await read(path)
    if (text !== null) return { path, text }
  }
  return undefined
}

/** Rules reached from one goal, at most. */
const MAX_RULES = 64

/**
 * The rules Make follows for `goals` (the first rule's target when none is
 * given) and, through their prerequisites, every explicit rule they reach:
 * their lines as written, and each recipe line as a command. Variables stay
 * unexpanded, so a name built from one is never read as a file's; pattern
 * rules, included files and conditionals aren't followed.
 */
export function makeRules(makefile: string, goals: readonly string[]): { text: string; recipes: string[] } | undefined {
  const rules = new Map<string, { lines: string[]; prerequisites: string[]; recipes: string[] }>()
  let first: string | undefined
  let current: { lines: string[]; prerequisites: string[]; recipes: string[] }[] = []
  for (const line of makefile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      const recipe = line.slice(1).replace(/^[-@+\s]+/, "").trim()
      for (const rule of current) {
        rule.lines.push(line)
        if (recipe && !recipe.startsWith("#")) rule.recipes.push(recipe)
      }
      continue
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const rule = /^([^\s:=#][^:=#]*?)\s*::?(?![=:])(.*)$/.exec(line)
    if (!rule) {
      current = []
      continue
    }
    const [prerequisites = "", inline] = rule[2]!.split(";", 2)
    const targets = rule[1]!.split(/\s+/).filter(Boolean)
    current = targets.map((target) => {
      const found = rules.get(target) ?? { lines: [], prerequisites: [], recipes: [] }
      found.lines.push(line)
      // Order-only prerequisites follow a `|`; they are prerequisites all the same.
      found.prerequisites.push(...prerequisites.split(/[\s|]+/).filter(Boolean))
      if (inline?.trim()) found.recipes.push(inline.trim())
      rules.set(target, found)
      return found
    })
    first ??= targets.find((target) => !target.startsWith(".") && !target.includes("%"))
  }
  const queue = goals.length ? [...goals] : first ? [first] : []
  const reached = new Set<string>()
  const lines: string[] = []
  const recipes: string[] = []
  while (queue.length && reached.size < MAX_RULES) {
    const target = queue.shift()!
    const rule = rules.get(target)
    if (reached.has(target) || !rule) continue
    reached.add(target)
    lines.push(...rule.lines)
    recipes.push(...rule.recipes)
    queue.push(...rule.prerequisites)
  }
  return lines.length ? { text: lines.join("\n"), recipes } : undefined
}
