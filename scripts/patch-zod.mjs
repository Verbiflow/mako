// Zod's classic schemas cost 7.5 KB each, and the host makes 18,967 of them as it imports its modules: 127 MB of the
// 137 MB those modules hold (2026-11-07, a scratch import of every module the host loads at boot). Most of that is
// per-schema: a closure for each method, about 45 of them, and the property slots to hold them. Zod already puts its
// builder methods (`optional`, `array`, `refine`...) on the prototype, bound on first use (`_installLazyMethods`); this
// does the same for the rest: the parse family, `toJSONSchema`, the string, number, bigint, date, array, set, file and
// wrapper methods, and the JSON schema helpers of `~standard`. A `z.string()` goes from 7.5 KB to 2.0 KB, smaller than
// `zod/mini`'s; the host's import heap from 137 MB to 87 MB, the same schemas. A method is still each schema's own
// function once it's asked for, so detached use (`const { parse } = schema`) works as it did.
//
// Only the ES module build changes: nothing here requires zod's CommonJS one, and a package that does gets zod as it
// shipped. The patch is for one version: another prints why it's skipped, and `test:zod-patch` fails until it's ported.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"

const VERSION = "4.4.3"
const MARK = "/* mako: methods bound on first use (scripts/patch-zod.mjs) */"
const require = createRequire(import.meta.url)

let root
try {
  root = dirname(require.resolve("zod/package.json"))
} catch {
  process.exit(0)
}
// A checkout whose packages are another's links (a worktree's, until it owns them) would write into that one's zod.
const here = join(dirname(import.meta.dirname), "node_modules", "zod")
const linked = lstatSync(here, { throwIfNoEntry: false })?.isSymbolicLink()
if (linked || relative(realpathSync(join(dirname(import.meta.dirname), "node_modules")), realpathSync(root)).startsWith("..")) {
  console.warn(`patch-zod: zod here is another checkout's (${realpathSync(root)}); it's patched where it's installed`)
  process.exit(0)
}
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (version !== VERSION) {
  console.warn(`patch-zod: zod ${version} isn't ${VERSION}, which this patch was written for; schemas keep their per-instance methods`)
  process.exit(0)
}
const file = join(root, "v4/classic/schemas.js")
const source = readFileSync(file, "utf8")
if (source.startsWith(MARK)) process.exit(0)

/** `source` with `before` replaced, which must be there exactly once. */
function replaceOnce(text, before, after) {
  const at = text.indexOf(before)
  if (at < 0 || text.indexOf(before, at + 1) >= 0) throw new Error(`patch-zod: zod ${VERSION}'s classic schemas aren't as this patch expects`)
  return text.slice(0, at) + after + text.slice(at + before.length)
}

// One line, `inst.NAME = (ARGS) => EXPR;`, using only the schema, its arguments and the module's own: a method.
const METHOD = /^ {4}inst\.([A-Za-z0-9]+) = (async )?\(([^()]*)\) => (.+);$/
// `inst.NAME = inst.OTHER;`: another name for a method.
const ALIAS = /^ {4}inst\.([A-Za-z0-9]+) = inst\.([A-Za-z0-9]+);$/
// What a constructor's own variables are: a line that reads one is data, made for this schema, and stays.
const LOCAL = /(?<![.\w])(def|bag|c)\b/
const CONSTRUCTOR = /^export const \w+ = \/\*@__PURE__\*\/ core\.\$constructor\("(\w+)"/

const out = []
let name
let methods = []
let at
let moved = 0
const flush = () => {
  if (methods.length) out.splice(at, 0, `    _installBoundMethods(inst, "${name}", {\n${methods.join(",\n")}\n    });`)
  methods = []
  at = undefined
}
for (const line of source.split("\n")) {
  const opened = CONSTRUCTOR.exec(line)
  if (opened) {
    flush()
    name = opened[1]
  }
  if (line.startsWith("});")) flush()
  const method = name && METHOD.exec(line)
  if (method && !LOCAL.test(method[4])) {
    const [, key, async, args, body] = method
    at ??= out.length
    methods.push(`        ${async ?? ""}${key}(${args}) { return ${body.replace(/\binst\b/g, "this")}; }`)
    moved += 1
    continue
  }
  const alias = name && ALIAS.exec(line)
  if (alias) {
    at ??= out.length
    methods.push(`        ${alias[1]}(...args) { return this.${alias[2]}(...args); }`)
    moved += 1
    continue
  }
  out.push(line)
}
flush()
let patched = out.join("\n")
// A method bound on first use, as zod's own builder methods are (`_installLazyMethods`), but kept only where the schema
// can take it: a frozen, sealed or locked one gets it bound afresh each time, and one set on a locked schema is kept
// beside it, so every schema behaves as when each was its own property, a frozen one refusing a new value included.
patched = replaceOnce(patched, `function _installLazyMethods(inst, group, methods) {`, `const _boundGroups = new WeakMap();
const _boundSet = new WeakMap();
function _installBoundMethods(inst, group, methods) {
    const proto = Object.getPrototypeOf(inst);
    let installed = _boundGroups.get(proto);
    if (!installed) {
        installed = new Set();
        _boundGroups.set(proto, installed);
    }
    if (installed.has(group))
        return;
    installed.add(group);
    for (const key in methods) {
        const fn = methods[key];
        Object.defineProperty(proto, key, {
            configurable: true,
            enumerable: false,
            get() {
                const set = _boundSet.get(this);
                if (set && Object.prototype.hasOwnProperty.call(set, key))
                    return set[key];
                const bound = fn.bind(this);
                if (Object.isExtensible(this))
                    Object.defineProperty(this, key, { configurable: true, writable: true, enumerable: true, value: bound });
                return bound;
            },
            set(value) {
                if (Object.isExtensible(this)) {
                    Object.defineProperty(this, key, { configurable: true, writable: true, enumerable: true, value });
                    return;
                }
                if (Object.isFrozen(this))
                    throw new TypeError(\`Cannot assign to read only property '\${key}' of object\`);
                let set = _boundSet.get(this);
                if (!set)
                    _boundSet.set(this, (set = Object.create(null)));
                set[key] = value;
            },
        });
    }
}
function _installLazyMethods(inst, group, methods) {`)
// The JSON schema helpers zod adds to \`~standard\`, made when \`~standard\` is first read, as the rest of it already is,
// and kept as zod keeps it, in its getter rather than on the schema, so a schema frozen first still reads it.
patched = replaceOnce(patched, `    Object.assign(inst["~standard"], {
        jsonSchema: {
            input: createStandardJSONSchemaMethod(inst, "input"),
            output: createStandardJSONSchemaMethod(inst, "output"),
        },
    });
    inst.toJSONSchema = createToJSONSchemaMethod(inst, {});`, `    const standard = Object.getOwnPropertyDescriptor(inst, "~standard");
    if (standard && standard.get) {
        const made = standard.get;
        let value;
        Object.defineProperty(inst, "~standard", {
            configurable: true,
            enumerable: false,
            get() {
                if (value === undefined) {
                    value = made.call(inst);
                    if (value)
                        Object.assign(value, { jsonSchema: { input: createStandardJSONSchemaMethod(inst, "input"), output: createStandardJSONSchemaMethod(inst, "output") } });
                }
                return value;
            },
            set: standard.set,
        });
    }
    _installBoundMethods(inst, "ZodType#json", {
        toJSONSchema(params) { return createToJSONSchemaMethod(this, {})(params); },
    });`)
if (moved < 75) throw new Error(`patch-zod: only ${moved} methods matched; zod ${VERSION}'s classic schemas aren't as this patch expects`)
writeFileSync(file, `${MARK}\n${patched}`)
