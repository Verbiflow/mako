// For tests: the installed @cursor/sdk, and its code found by shape rather than by the names one release's bundler
// gave it, so a release that only renames breaks no test.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { tokenizer, tokTypes } from "acorn"
import { locate, rename, translate } from "./anchored-patch.mjs"
import { CURSOR_SDK_PATCHES, folderFiles, installedPatch } from "../patch-cursor-sdk.mjs"

export const sdkRoot = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "..")
export const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version
export const readSdk = (target) => readFileSync(join(sdkRoot, target), "utf8")
export const sdkFiles = folderFiles(sdkRoot)

/** The one file of `build` holding `literal` once by shape, where, and the names there (1.4.0's to this release's). */
export function findInBuild(build, literal, what = literal.slice(0, 80)) {
  const hits = sdkFiles(build).flatMap((file) => {
    const target = `dist/${build}/${file}`
    const source = readSdk(target)
    const hit = locate(source, literal)
    return hit.count === 1 ? [{ target, source, ...hit }] : []
  })
  if (hits.length !== 1) throw new Error(`@cursor/sdk ${sdkVersion} ${build}: ${hits.length ? `${hits.length} files hold` : "no file holds"} ${what}`)
  return hits[0]
}

/** `source` from `index` through the brace that closes the first block opened after it. */
export function throughBlock(source, index) {
  const body = source.indexOf("{", index)
  let depth = 0
  for (const token of tokenizer(source.slice(body), { ecmaVersion: "latest" })) {
    if (token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) depth++
    else if (token.type === tokTypes.braceR && --depth === 0) return source.slice(index, body + token.end)
  }
  throw new Error(`no end to the block at ${index}`)
}

/**
 * A vm context for code cut out of the bundle: what `given` names, then the process's globals, and `stub` for every
 * other name, which is a name of the bundle's own module that the code reaches out to, whatever this release calls it.
 */
export function bundleContext(given, stub) {
  return new Proxy(given, {
    has: () => true,
    // A name the code was handed, else one of the process's globals, else one of its module's.
    get: (target, key) => (key in target ? target[key] : key in globalThis ? globalThis[key] : stub),
  })
}

/** `patch`'s sites in an installed source taken back to their unpatched text, in this release's names. */
export function unpatched(build, id) {
  const { source, sites } = installedPatch(readSdk, sdkFiles, id, build)
  const names = new Map(sites.flatMap((site) => [...site.names]))
  let text = source
  for (const site of [...sites].sort((a, b) => b.index - a.index))
    text = text.slice(0, site.index) + translate(site.from, names, site.label) + text.slice(site.index + site.length)
  return text
}

export { CURSOR_SDK_PATCHES, installedPatch, rename }
