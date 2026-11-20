// Zod's classic schemas cost 7.5 KB each, and the host makes 18,967 of them as it imports its modules: 127 MB of the
// 137 MB those modules hold (2026-11-07, a scratch import of every module the host loads at boot). Most of that is
// per-schema: a closure for each method, about 45 of them, and the property slots to hold them. Zod already puts its
// builder methods (`optional`, `array`, `refine`...) on the prototype, bound on first use (`_installLazyMethods`); this
// does the same for the rest: the parse family, `toJSONSchema`, the string, number, bigint, date, array, set, file and
// wrapper methods, and the JSON schema helpers of `~standard`. A `z.string()` goes from 7.5 KB to 2.0 KB, smaller than
// `zod/mini`'s; the host's import heap from 137 MB to 87 MB, the same schemas. A method is still each schema's own
// function once it's asked for, so detached use (`const { parse } = schema`) works as it did.
//
// Then (`LAZY`) what still made each schema large: V8 kept every one as a dictionary, several times the size of an
// object with a shared shape, as each had accessors of its own with closures of its own (zod's lazy properties,
// `description`, and the `~standard` the first part redefined). Those accessors move to prototypes, each object's
// getters kept beside it; a schema's `_zod` gets a prototype of its own to hold its lazy ones; `~standard` takes its
// JSON schema methods as it's made; and the closures a schema's construction ran aren't kept after. A `z.string()` goes
// from 2.0 KB to 1.2 KB, and every schema stays a fast object; what each reads, parses and says is as before.
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
/** Writes `file` as `head`, `LAZY` and `source` changed by `change`, unless it carries `LAZY` already. */
function patchFile(path, head, source, change) {
  if (source.startsWith(`${LAZY}\n`)) {
    if (`${head}${source}` !== readFileSync(path, "utf8")) writeFileSync(path, `${head}${source}`)
    return
  }
  writeFileSync(path, `${head}${LAZY}\n${change(source)}`)
}

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

/** The classic schemas with zod's methods bound on first use, as its builder methods are. */
function bindMethods(source) {
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
return patched
}


/** What `bindMethods` made `~standard`: its accessor redefined on every schema, which left each a dictionary. */
const STANDARD_REDEFINED = `    const standard = Object.getOwnPropertyDescriptor(inst, "~standard");
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
`

/** Classic: `~standard`'s JSON schema methods added as zod's core makes it (`lazyStandard`), and `description` and a literal's `value` read on the prototype. */
function lazyClassic(source) {
  let patched = replaceOnce(source, STANDARD_REDEFINED, "")
  patched = replaceOnce(patched, `export const ZodType = /*@__PURE__*/ core.$constructor("ZodType", (inst, def) => {`, `// Each schema's \`~standard\` with its JSON schema methods, added as core makes it on first read.
core.$standardExtras.add = (inst, value) => Object.assign(value, { jsonSchema: { input: createStandardJSONSchemaMethod(inst, "input"), output: createStandardJSONSchemaMethod(inst, "output") } });
export const ZodType = /*@__PURE__*/ core.$constructor("ZodType", (inst, def) => {`)
  // A literal's \`value\`, read from the schema's own definition by one getter on its prototype.
  patched = replaceOnce(patched, `    Object.defineProperty(inst, "value", {
        get() {
            if (def.values.length > 1) {
                throw new Error("This schema contains multiple valid literal values. Use \`.values\` instead.");
            }
            return def.values[0];
        },
    });`, `    const proto = Object.getPrototypeOf(inst);
    if (!Object.prototype.hasOwnProperty.call(proto, "value"))
        Object.defineProperty(proto, "value", {
            get() {
                const values = this._zod.def.values;
                if (values.length > 1) {
                    throw new Error("This schema contains multiple valid literal values. Use \`.values\` instead.");
                }
                return values[0];
            },
        });`)
  return replaceOnce(patched, `    Object.defineProperty(inst, "description", {
        get() {
            return core.globalRegistry.get(inst)?.description;
        },
        configurable: true,
    });
    return inst;`, `    // One getter on the schema's prototype for every schema of it, rather than one for each.
    const proto = Object.getPrototypeOf(inst);
    if (!Object.prototype.hasOwnProperty.call(proto, "description"))
        Object.defineProperty(proto, "description", {
            get() {
                return core.globalRegistry.get(this)?.description;
            },
            configurable: true,
        });
    return inst;`)
}

/**
 * Core's `defineLazy`: the accessor on the object's prototype, made once for each key there, and each object's getter
 * and value kept beside it in a WeakMap, read as the accessor of its own read them: once, `undefined` read again, a
 * getter reading itself `undefined`, a set value the object's own. An object whose prototype isn't one of its kind's
 * (a plain object, an array), or that has the key already, gets its own accessor as before.
 */
function lazyUtil(source) {
  return replaceOnce(source, `export function defineLazy(object, key, getter) {
    let value = undefined;`, `const lazyGetters = new WeakMap();
const lazyKeys = new WeakMap();
const sharedPrototype = (proto) => proto === null || proto === Object.prototype || proto === Function.prototype || proto === Array.prototype;
export function defineLazy(object, key, getter) {
    const proto = Object.getPrototypeOf(object);
    if (sharedPrototype(proto) || Object.prototype.hasOwnProperty.call(object, key))
        return defineOwnLazy(object, key, getter);
    let keys = lazyKeys.get(proto);
    if (!keys) {
        keys = new Set();
        lazyKeys.set(proto, keys);
    }
    if (!keys.has(key)) {
        if (Object.prototype.hasOwnProperty.call(proto, key))
            return defineOwnLazy(object, key, getter);
        keys.add(key);
        Object.defineProperty(proto, key, {
            get() {
                const table = lazyGetters.get(this);
                const entry = table?.[key];
                if (entry === undefined || entry === EVALUATING)
                    return undefined;
                if (typeof entry !== "function")
                    return entry.value;
                table[key] = EVALUATING;
                const value = entry();
                table[key] = value === undefined ? entry : { value };
                return value;
            },
            set(v) {
                Object.defineProperty(this, key, {
                    value: v,
                });
            },
            configurable: true,
        });
    }
    let table = lazyGetters.get(object);
    if (!table) {
        table = Object.create(null);
        lazyGetters.set(object, table);
    }
    table[key] = getter;
}
function defineOwnLazy(object, key, getter) {
    let value = undefined;`)
}

/** Core's constructor: every schema's \`_zod\` on one prototype, which holds their lazy properties; and its run closures let go. */
function lazyCore(source) {
  let patched = replaceOnce(source, `export /*@__NO_SIDE_EFFECTS__*/ function $constructor(name, initializer, params) {`, `/** The prototype of every schema's \`_zod\`, where its lazy properties are (\`defineLazy\`). */
export const $internals = {};
/** What a wrapping build adds to each schema's \`~standard\` as it's made: classic's JSON schema methods. */
export const $standardExtras = {};
export /*@__NO_SIDE_EFFECTS__*/ function $constructor(name, initializer, params) {`)
  patched = replaceOnce(patched, `            Object.defineProperty(inst, "_zod", {
                value: {
                    def,
                    constr: _,
                    traits: new Set(),
                },
                enumerable: false,
            });`, `            const internals = Object.create($internals);
            internals.def = def;
            internals.constr = _;
            internals.traits = new Set();
            Object.defineProperty(inst, "_zod", {
                value: internals,
                enumerable: false,
            });`)
  return replaceOnce(patched, `        for (const fn of inst._zod.deferred) {
            fn();
        }
        return inst;`, `        for (const fn of inst._zod.deferred) {
            fn();
        }
        // Only a schema's construction runs them, and they've run: their closures needn't stay with it.
        inst._zod.deferred.length = 0;
        return inst;`)
}

/** Core's \`~standard\`, with what a wrapping build adds to it (\`$standardExtras\`), made on first read as before. */
function lazyStandard(source) {
  return replaceOnce(source, `    util.defineLazy(inst, "~standard", () => ({
        validate: (value) => {
            try {
                const r = safeParse(inst, value);
                return r.success ? { value: r.data } : { issues: r.error?.issues };
            }
            catch (_) {
                return safeParseAsync(inst, value).then((r) => (r.success ? { value: r.data } : { issues: r.error?.issues }));
            }
        },
        vendor: "zod",
        version: 1,
    }));
});`, `    util.defineLazy(inst, "~standard", () => {
        const standard = {
            validate: (value) => {
                try {
                    const r = safeParse(inst, value);
                    return r.success ? { value: r.data } : { issues: r.error?.issues };
                }
                catch (_) {
                    return safeParseAsync(inst, value).then((r) => (r.success ? { value: r.data } : { issues: r.error?.issues }));
                }
            },
            vendor: "zod",
            version: 1,
        };
        return core.$standardExtras.add ? core.$standardExtras.add(inst, standard) : standard;
    });
});`)
}

const LAZY = "/* mako: lazy properties on prototypes (scripts/patch-zod.mjs) */"
const file = join(root, "v4/classic/schemas.js")
const installed = readFileSync(file, "utf8")
/** The classic schemas with their methods bound on first use: as zod ships them, moved, or as an earlier run left them. */
const methodsBound = installed.startsWith(MARK) ? installed.slice(MARK.length + 1) : bindMethods(installed)
patchFile(file, `${MARK}\n`, methodsBound, lazyClassic)
patchFile(join(root, "v4/core/util.js"), "", readFileSync(join(root, "v4/core/util.js"), "utf8"), lazyUtil)
patchFile(join(root, "v4/core/core.js"), "", readFileSync(join(root, "v4/core/core.js"), "utf8"), lazyCore)
patchFile(join(root, "v4/core/schemas.js"), "", readFileSync(join(root, "v4/core/schemas.js"), "utf8"), lazyStandard)
