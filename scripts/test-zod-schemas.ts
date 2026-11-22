import assert from "node:assert/strict"
import { z } from "zod"

/**
 * What the host needs of zod's schemas, held against the zod installed here. The host makes about 19,000 of them as
 * it imports its modules, so what one holds decides tens of megabytes: zod 4.4.3 shipped each with a closure for every
 * method and accessors of its own (7.5 KB a `z.string()`, every schema a dictionary to V8), and Mako patched that
 * (`scripts/patch-zod.mjs`, to 1.2 KB). Zod keeps its methods and lazy properties on prototypes itself from 4.6 on
 * (0.7 KB, measured on 4.6.7, 2026-11-21), so the patch is gone and this holds zod to it: a schema owning no method
 * until one is asked for, every method and lazy property behaving as before, a schema small and of a shared shape.
 * Run with `--allow-natives-syntax` to check the shapes.
 */
// A schema owns no method until one is asked for.
const fresh = z.string()
for (const method of ["parse", "safeParse", "parseAsync", "email", "url", "min", "toJSONSchema"])
  assert.equal(Object.getOwnPropertyNames(fresh).includes(method), false, `a new schema holds no ${method} of its own`)

// Every method it moved behaves as zod's own.
const words = z.string()
assert.equal(words.parse("hi"), "hi")
assert.throws(() => words.parse(1))
assert.equal(words.safeParse(1).success, false)
assert.equal((await words.parseAsync("a")), "a")
assert.equal((await words.safeParseAsync(2)).success, false)
assert.equal((await words.spa("b")).success, true, "spa is safeParseAsync")
const { parse, safeParse } = z.number()
assert.equal(parse(3), 3, "a method asked for apart from its schema still parses")
assert.equal(safeParse("x").success, false)
assert.equal(z.string().email().safeParse("someone@example.com").success, true)
assert.equal(z.string().email().safeParse("not mail").success, false)
assert.equal(z.string().url().safeParse("https://example.com").success, true)
assert.equal(z.string().uuid().safeParse("1b4e28ba-2fa1-11d2-883f-0016d3cca427").success, true)
assert.equal(z.string().datetime().safeParse("2026-11-07T02:00:00Z").success, true)
assert.equal(z.string().ipv4().safeParse("10.0.0.1").success, true)
assert.equal(z.number().min(2).safeParse(1).success, false)
assert.equal(z.number().max(2).gte(1).safeParse(1.5).success, true)
assert.equal(z.number().positive().safeParse(0).success, false)
assert.equal(z.number().multipleOf(3).safeParse(9).success, true)
assert.equal(z.bigint().nonnegative().safeParse(-1n).success, false)
assert.equal(z.date().min(new Date(0)).safeParse(new Date(1)).success, true)
assert.equal(z.array(z.string()).min(1).safeParse([]).success, false)
assert.equal(z.array(z.string()).nonempty().max(2).safeParse(["a"]).success, true)
assert.equal(z.set(z.number()).size(2).safeParse(new Set([1, 2])).success, true)
assert.equal(z.string().optional().unwrap().safeParse("a").success, true)
assert.equal(z.string().nullable().unwrap().safeParse(null).success, false)
assert.equal(z.string().default("d").removeDefault().safeParse(undefined).success, false, "removeDefault is unwrap")
assert.equal(z.string().default("d").parse(undefined), "d")
const color = z.enum(["red", "green", "blue"])
assert.deepEqual(color.extract(["red"]).options, ["red"])
assert.deepEqual(color.exclude(["red"]).options, ["green", "blue"])
assert.deepEqual(z.tuple([z.string()]).rest(z.number()).parse(["a", 1, 2]), ["a", 1, 2])
const codec = z.codec(z.string(), z.number(), { decode: (text) => Number(text), encode: (value) => String(value) })
assert.equal(codec.decode("4"), 4)
assert.equal(codec.encode(4), "4")
assert.equal(codec.safeDecode("5").success, true)
assert.equal((await codec.decodeAsync("6")), 6)
assert.equal((await codec.safeEncodeAsync(7)).success, true)
const thing = z.object({ id: z.string(), at: z.number().optional() })
assert.deepEqual(thing.toJSONSchema().required, ["id"], "toJSONSchema")
assert.deepEqual(z.toJSONSchema(thing), thing.toJSONSchema())
const standard = thing["~standard"]
assert.equal(standard.vendor, "zod")
const validated = standard.validate({ id: "a" })
assert.ok(!(validated instanceof Promise) && "value" in validated, "the standard schema validates")
assert.deepEqual(standard.jsonSchema.input({ target: "draft-2020-12" }).required, ["id"], "and says its JSON schema")
assert.equal(thing["~standard"], standard, "made once")
const overridden = z.string()
overridden.parse = () => "mine"
assert.equal(overridden.parse("x"), "mine", "a method set on a schema is its own")

// A schema frozen, sealed or locked before its first use is one zod 4.6 doesn't parse with: its methods are kept on it
// as they're first asked for, which a locked one refuses. Nothing in Mako locks a schema; this says so if zod changes.
assert.throws(() => Object.freeze(z.string()).safeParse("x"), TypeError, "a frozen schema is still one zod can't keep a method on")

// Lazy properties read as zod's own: computed once on first read, each schema its own, a getter's undefined read again.
const kinds = z.enum(["a", "b"])
assert.deepEqual([...kinds._zod.values], ["a", "b"], "an enum's values")
assert.equal(z.string().optional()._zod.optin, "optional", "an optional's optin")
assert.equal(z.string()._zod.optin, undefined, "a plain string has none")
assert.equal(z.literal("x")._zod.values?.has("x"), true, "a literal's values")
const either = z.discriminatedUnion("type", [z.object({ type: z.literal("a"), n: z.number() }), z.object({ type: z.literal("b"), s: z.string() })])
assert.deepEqual(either.parse({ type: "b", s: "x" }), { type: "b", s: "x" }, "a discriminated union finds its option by its values")
assert.equal(either.safeParse({ type: "c" }).success, false)
const profile = z.object({ a: z.string(), b: z.number().optional() })
assert.deepEqual(Object.keys(profile["shape"]), ["a", "b"], "an object's fields, a lazy property of its own")
assert.equal(profile["shape"], profile["shape"], "read once")
assert.deepEqual(profile.extend({ c: z.boolean() }).parse({ a: "x", c: true }), { a: "x", c: true })
const one = z.enum(["x"]), other = z.enum(["y"])
assert.notEqual(one._zod.values, other._zod.values, "each schema its own")
const described = z.string().describe("a word")
assert.equal(described.description, "a word", "description, as zod's registry has it")
assert.equal(z.string().description, undefined)
assert.equal(z.string().meta({ description: "meta" }).description, "meta")

// Every schema keeps a shared shape, its `_zod` too: V8 made each a dictionary while each had accessors of its own.
/** V8's own answer, where Node runs with `--allow-natives-syntax`: whether a schema, or its internals, has fast properties. */
interface LayoutCheck {
  (value: z.ZodType | z.ZodType["_zod"]): boolean
}
const fastPropertiesCheck = ((): LayoutCheck | undefined => {
  try {
    const check = new Function("value", "return %HasFastProperties(value) === true")
    return (value) => check(value) === true
  } catch {
    console.log("zod schemas: object layouts not checked; run with --allow-natives-syntax")
    return undefined
  }
})()
if (fastPropertiesCheck) {
  const made: [string, () => z.ZodType][] = [
    ["string", () => z.string()], ["number", () => z.number().int()], ["object", () => z.object({ a: z.string() })],
    ["optional", () => z.string().optional()], ["enum", () => z.enum(["a"])], ["array", () => z.array(z.string())],
    ["union", () => z.union([z.string(), z.number()])], ["discriminated", () => either], ["checked", () => z.string().min(1).max(3)],
    ["record", () => z.record(z.string(), z.number())], ["described", () => z.string().describe("d")],
  ]
  for (const [kind, make] of made) {
    const schema = make()
    void schema["~standard"]
    void schema._zod.optin
    assert.equal(fastPropertiesCheck(schema), true, `a ${kind} schema keeps fast properties`)
    assert.equal(fastPropertiesCheck(schema._zod), true, `and its _zod`)
  }
}

// A schema is small: 7.5 KB each as zod 4.4.3 shipped, 1.2 KB with Mako's patch of it, 0.7 KB as zod 4.6.7 ships, measured here over many.
const gc = globalThis.gc
if (gc) {
  const used = () => { gc(); gc(); return process.memoryUsage().heapUsed }
  const count = 20_000
  const before = used()
  const kept = Array.from({ length: count }, () => z.string())
  const each = (used() - before) / count
  assert.ok(each < 1_000, `a z.string() holds ${each.toFixed(0)} bytes, under 1 KB`)
  void kept.length
  // A literal is the one kind zod 4.6.7 leaves a dictionary (its `value` is an accessor of its own); it is no larger for it
  // (1.7 KB, as with Mako's patch of 4.4.3), which this holds.
  const literalsBefore = used()
  const literals = Array.from({ length: count }, () => z.literal("a"))
  const literal = (used() - literalsBefore) / count
  assert.ok(literal < 2_000, `a z.literal() holds ${literal.toFixed(0)} bytes, under 2 KB`)
  void literals.length
  console.log(`zod schemas: a z.string() holds ${each.toFixed(0)} bytes`)
}
console.log("zod schemas: no method of its own until asked for, lazy properties on prototypes, every schema a shared shape")
