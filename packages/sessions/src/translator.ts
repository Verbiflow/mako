import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The code that turns a harness's native records into entries. A translation saved by other code is stale even when
 * the native record is unchanged, so a parser fix reaches conversations translated before it; a translation saved by
 * code that differs only where this harness's records never go is not, and stays.
 *
 * So each harness has its own fingerprint: the bytes of its readers (`HARNESS_READERS`) and of every module they import,
 * followed import by import (its decoder, the vocabularies, the entry format and its sinks), with `TRANSLATION_FORMAT`.
 * The record store, the catalog, the daemon, sync and the other harnesses' decoders are outside it: an update that
 * changed only those keeps every view, where one hash over the package had every update decode every Thread again.
 * A harness this package has no reader for (one passed in from outside) is fingerprinted by the whole package, as
 * every harness once was.
 */

/** Bumped by hand when what a decode makes changes without any of the code it hashes changing (a dependency's output). */
const TRANSLATION_FORMAT = 1

/** Each harness's readers in this package, relative to it: where its fingerprint starts. */
const HARNESS_READERS = new Map<string, readonly string[]>([
  ["claude", ["providers/claude"]],
  ["codex", ["providers/codex"]],
  ["cursor", ["providers/cursor"]],
  ["devin", ["providers/devin-local", "providers/devin-cli"]],
  ["grok", ["providers/grok"]],
  ["opencode", ["providers/opencode"]],
])

/**
 * Modules a decode imports whose words never reach an entry. `mako-tools.ts` words a call of Mako's own server for a
 * row ("Started fin:x on Codex"); a decode keeps the call as it was (its name, input and output), and the window words
 * it as it draws it (`makoCallWords`), so new words reach every Thread without decoding one again. Checked by
 * `test/translator-scope.mjs`: no entry a decode makes holds them.
 */
const DISPLAY_ONLY = new Set(["mako-tools"])

/** An import or re-export of a module beside it that is not types alone: `import { a } from "./b.js"`, `export * from "../c.js"`, `import("./d.js")`. */
const IMPORTS = /(?:^|[;\n])\s*(?:import|export)\s+(?!type[\s{*])(?:[^"';]*?\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g

/** The fingerprint of `harness`'s translation by the package at `root` (its `src` or `dist`), whose modules end in `extension`. */
export function translatorOf(root: string, extension: ".ts" | ".js", harness: string): string {
  const hash = createHash("sha256").update(`translation ${TRANSLATION_FORMAT}\0${HARNESS_READERS.has(harness) ? harness : "package"}\0`)
  for (const path of scopeOf(root, extension, harness)) hash.update(relative(root, path)).update("\0").update(readFileSync(path))
  return hash.digest("hex").slice(0, 16)
}

/** The modules `harness`'s fingerprint covers, relative to the package's root. */
export function translatorScope(root: string, extension: ".ts" | ".js", harness: string): string[] {
  return scopeOf(root, extension, harness).map((path) => relative(root, path))
}

function scopeOf(root: string, extension: string, harness: string): string[] {
  const readers = HARNESS_READERS.get(harness)
  return readers ? closure(root, extension, readers, harness) : filesUnder(root, extension)
}

/** Whether module `name` is the vocabulary of a harness other than `harness` (`harnesses/codex` for Cursor's). */
function otherVocabulary(name: string, harness: string): boolean {
  const [folder, file] = name.split("/")
  return folder === "harnesses" && file !== harness && file !== undefined && HARNESS_READERS.has(file)
}

/**
 * Every module `readers` import, themselves included, but `DISPLAY_ONLY`, by path in order. The harnesses' index
 * (`harnesses/index.ts`) lists every harness's vocabulary, and each harness's records are read with its own alone
 * (`VOCABULARIES.find` by harness, in `tool-identity.ts`): what the index imports of another harness's is left out, so
 * a harness's bump (its tools, its checked version) decodes only its own Threads again. A module that imports
 * another harness's vocabulary itself still has it followed.
 */
function closure(root: string, extension: string, readers: readonly string[], harness: string): string[] {
  const seen = new Set<string>()
  const visit = (path: string): void => {
    if (seen.has(path)) return
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch {
      return
    }
    seen.add(path)
    for (const match of text.matchAll(IMPORTS)) {
      const specifier = match[1] ?? match[2]
      if (!specifier?.endsWith(".js")) continue
      const target = join(dirname(path), specifier.slice(0, -".js".length) + extension)
      const name = relative(root, target).slice(0, -extension.length)
      if (DISPLAY_ONLY.has(name) || (relative(root, path) === `harnesses/index${extension}` && otherVocabulary(name, harness))) continue
      visit(target)
    }
  }
  for (const reader of readers) visit(join(root, reader + extension))
  return [...seen].sort()
}

function filesUnder(root: string, extension: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path)
    }
  }
  visit(root)
  return files
}

/** `harness`'s fingerprint in this build: `translatorOf` this package's code as it runs, a few dozen files read and hashed. */
export function translatorBuild(harness: string): string {
  return translatorOf(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? ".ts" : ".js", harness)
}

/** `translatorBuild`, each harness's hashed once, the first time it's asked for: what a catalog keeps. */
export function translatorBuilds(): (harness: string) => string {
  const built = new Map<string, string>()
  return (harness) => {
    let fingerprint = built.get(harness)
    if (fingerprint === undefined) built.set(harness, (fingerprint = translatorBuild(harness)))
    return fingerprint
  }
}
