// Two packages a host loads at an agent's first launch build every schema of their protocol as they're imported,
// though a session checks its messages against a few of them (heap after a collection, 2026-11-21):
//
//   @agentclientprotocol/sdk    262 schemas in `dist/schema/zod.gen.js`, 5.1 MB of the 5.6 MB a host holds from its
//                               first Grok or Devin session on
//   @modelcontextprotocol/sdk   152 in `dist/esm/types.js` (101 of them made lazy), 2.2 MB of the 5.4 MB it holds from an agent's first
//                               request to Mako's servers on
//
// Each exported schema becomes a `z.lazy` of what it was, built when a message is first checked against it or against
// one made of it: the same schema then, so what a message parses to, and what is refused and why, is as the package
// shipped it. A lazy schema parses and composes (`and`, `optional`, `array`...) as its own does, but has no `shape` to
// read or `extend`: a schema anything in its package uses that way, or registers a handler by (the method is read
// from its shape), or spreads into a union, stays as it shipped. The package's own code is read for that, every file
// of the build; `test:sdk-schemas` holds every lazy schema against the one shipped, part by part.
//
// Only those two modules change, each for one version: another prints why it's skipped, and `test:sdk-schemas` fails
// until it's read again. Only the ES module builds: nothing here requires either's CommonJS one.
//
//   node scripts/patch-sdk-schemas.mjs           patches the installed packages, once
//   node scripts/patch-sdk-schemas.mjs --check   fails unless they are patched
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export const SDK_SCHEMAS_MARK = "/* mako: schemas built on first use (scripts/patch-sdk-schemas.mjs) */"
/** Beside each patched module: what the package shipped, which `test:sdk-schemas` holds the patched one against. */
export const pristineName = (file) => file.replace(/\.js$/, ".mako-pristine.js")

/** What code may do with a schema it names and still mean the same of a lazy one. */
const LAZY_SAFE = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync", "optional", "nullable", "nullish", "and", "or", "array"])
/** Calls that read their schema's shape, and so need the schema itself. */
const TAKES_IT_WHOLE = /(setRequestHandler|setNotificationHandler|removeRequestHandler|removeNotificationHandler|assertRequestHandlerCapability|discriminatedUnion|\.merge|\.extend|\.safeExtend|keyof)\(\s*(["'][^"']*["']\s*,\s*)?(\[\s*)?$/

export const SDK_SCHEMAS = [
  {
    package: "@agentclientprotocol/sdk",
    version: "1.3.0",
    build: "dist",
    module: "schema/zod.gen.js",
    exported: /^export const (z[A-Za-z0-9_]+) = /,
    /** What the module's schemas number, lazy and not: a build that parses differently fails here before it's patched. */
    schemas: 262,
    lazy: 262,
  },
  {
    package: "@modelcontextprotocol/sdk",
    version: "1.30.0",
    build: "dist/esm",
    module: "types.js",
    exported: /^export const ([A-Za-z0-9_]+Schema) = /,
    // A request or a notification is what any program registers a handler by, Mako's servers and an agent's among
    // them: each stays whole, whether or not the package's own code registers one.
    whole: /(Request|Notification)Schema$/,
    schemas: 152,
    lazy: 101,
  },
]

function scripts(folder, under = "") {
  return readdirSync(join(folder, under), { withFileTypes: true }).flatMap((entry) => {
    const path = join(under, entry.name)
    if (entry.isDirectory()) return scripts(folder, path)
    return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") && !entry.name.endsWith(".mako-pristine.js") ? [path] : []
  })
}

/** The schemas of `names` that `code` uses as more than a parser: by a member a lazy schema lacks, or where a shape is read. */
function usedWhole(code, names) {
  const whole = new Set()
  for (const match of code.matchAll(/(\.\.\.)?\b([A-Za-z_$][A-Za-z0-9_$]*)\b(?:\.([A-Za-z_$][A-Za-z0-9_$]*))?/g)) {
    const [, spread, name, member] = match
    if (!names.has(name)) continue
    if (spread || (member && !LAZY_SAFE.has(member)) || TAKES_IT_WHOLE.test(code.slice(Math.max(0, match.index - 80), match.index))) whole.add(name)
  }
  return whole
}

/**
 * `source` with each exported schema lazy but those in `whole`. A statement is `export const <name> = <schema>;` from
 * the first column to the `;` ending the last line before the next first-column text, as both generators write them.
 */
export function lazySchemas(source, exported, whole = new Set()) {
  const lines = source.split("\n")
  const out = []
  const lazy = []
  let schemas = 0
  for (let index = 0; index < lines.length; ) {
    const head = exported.exec(lines[index])
    if (!head) {
      out.push(lines[index++])
      continue
    }
    schemas += 1
    let end = index
    while (end + 1 < lines.length && lines[end + 1] !== "" && /^[\s)\]}]/.test(lines[end + 1])) end += 1
    const statement = lines.slice(index, end + 1).join("\n")
    if (!statement.endsWith(";")) throw new Error(`${head[1]} doesn't end where its statement was expected to: ${statement.slice(-60)}`)
    if (whole.has(head[1])) out.push(statement)
    else {
      out.push(`${head[0]}z.lazy(() => ${statement.slice(head[0].length, -1)});`)
      lazy.push(head[1])
    }
    index = end + 1
  }
  return { text: out.join("\n"), schemas, lazy }
}

/** The package's module as patched, from what it shipped: which schemas stay whole is read from every file of its build. */
export function patchedModule(root, target, source) {
  const names = new Set([...source.matchAll(new RegExp(target.exported.source, "gm"))].map((match) => match[1]))
  const whole = new Set(target.whole ? [...names].filter((name) => target.whole.test(name)) : [])
  // In another file the module's exports go by their own names, or as members of a namespace import of it.
  for (const file of scripts(join(root, target.build))) {
    const code = file === target.module ? source : readFileSync(join(root, target.build, file), "utf8").replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\.(?=z[A-Z]|[A-Za-z0-9_]+Schema\b)/g, "")
    for (const name of usedWhole(code, names)) whole.add(name)
  }
  const made = lazySchemas(source, target.exported, whole)
  if (made.schemas !== target.schemas || made.lazy.length !== target.lazy)
    throw new Error(`${target.package} ${target.version}: ${made.schemas} schemas of which ${made.lazy.length} could be lazy, not the ${target.schemas} and ${target.lazy} this was written for`)
  return `${SDK_SCHEMAS_MARK}\n${made.text}`
}

/** Where `name` is installed in this checkout; nowhere when its packages are another checkout's links. */
export function installedPackage(name) {
  const modules = join(dirname(import.meta.dirname), "node_modules")
  const root = join(modules, ...name.split("/"))
  if (!lstatSync(root, { throwIfNoEntry: false })) return undefined
  if (lstatSync(modules).isSymbolicLink() || relative(realpathSync(modules), realpathSync(root)).startsWith("..")) return undefined
  return root
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check")
  for (const target of SDK_SCHEMAS) {
    const root = installedPackage(target.package)
    if (!root) continue
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const file = join(root, target.build, target.module)
    const source = readFileSync(file, "utf8")
    const patched = source.startsWith(SDK_SCHEMAS_MARK)
    if (check) {
      if (!patched) {
        console.error(`patch-sdk-schemas: ${target.package} ${version} isn't patched; run node scripts/patch-sdk-schemas.mjs`)
        process.exitCode = 1
      }
    } else if (version !== target.version) {
      console.warn(`patch-sdk-schemas: ${target.package} is ${version}, and this was written for ${target.version}; left as it shipped`)
    } else if (!patched) {
      const text = patchedModule(root, target, source)
      writeFileSync(join(root, target.build, pristineName(target.module)), source)
      writeFileSync(file, text)
      console.log(`patch-sdk-schemas: ${target.lazy} of ${target.package} ${version}'s ${target.schemas} schemas are built on first use`)
    }
  }
}
