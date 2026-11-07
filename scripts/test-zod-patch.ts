import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { z } from "zod"

/**
 * `scripts/patch-zod.mjs`: zod's methods bound on first use, as its builder methods already were, so a schema holds
 * none of its own until one is asked for. This holds the patch applied to the zod installed here, every method it
 * moved behaving as zod's own (detached too), and a schema small.
 */
const root = dirname(createRequire(import.meta.url).resolve("zod/package.json"))
assert.ok(readFileSync(join(root, "v4/classic/schemas.js"), "utf8").startsWith("/* mako: methods bound on first use"), "patch-zod.mjs has patched the zod installed here: run it, or port it to this version")

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

// A schema locked before its first use (frozen, sealed, not extensible) parses as zod's own did, whose methods were its
// own properties: the method is bound afresh each time instead of kept on it.
const locks: [(schema: z.ZodType) => z.ZodType, string][] = [[(schema) => Object.freeze(schema), "frozen"], [(schema) => Object.seal(schema), "sealed"], [(schema) => Object.preventExtensions(schema), "locked"]]
for (const [lock, how] of locks) {
  for (const [kind, make, good, bad] of [
    ["string", () => z.string(), "yes", 1],
    ["object", () => z.object({ a: z.string() }), { a: "yes" }, { a: 1 }],
    ["lazy", () => z.lazy(() => z.string()), "yes", 1],
  ] as const) {
    const schema: z.ZodType = lock(make())
    assert.deepEqual(schema.safeParse(good), { success: true, data: good }, `a ${how} ${kind} parses`)
    assert.equal(schema.safeParse(bad).success, false, `and refuses, ${how}`)
    assert.deepEqual(schema.parse(good), good)
    assert.deepEqual(await schema.parseAsync(good), good)
    const { safeParse: detached } = schema
    assert.equal(detached(good).success, true, `a ${how} ${kind}'s method apart from it`)
    const checked = schema["~standard"].validate(good)
    assert.ok(!(checked instanceof Promise) && "value" in checked, `a ${how} ${kind}'s standard schema validates`)
    assert.equal(schema["~standard"], schema["~standard"], "the same standard schema each time")
    assert.ok(schema.toJSONSchema(), `a ${how} ${kind} says its JSON schema`)
  }
}
// A value set on a sealed schema stays, as on zod's own property; a frozen one refuses it, as zod's own did.
const sealed = Object.seal(z.string())
sealed.parse = () => "mine"
assert.equal(sealed.parse("x"), "mine", "a sealed schema keeps a method set on it")
const frozen = Object.freeze(z.string())
assert.throws(() => Object.assign(frozen, { safeParse: () => "theirs" }), TypeError, "a frozen schema refuses one")
assert.equal(frozen.safeParse("x").success, true)

// A schema is small: 7.5 KB each before (2026-11-07), measured here over many.
const gc = globalThis.gc
if (gc) {
  const used = () => { gc(); gc(); return process.memoryUsage().heapUsed }
  const count = 20_000
  const before = used()
  const kept = Array.from({ length: count }, () => z.string())
  const each = (used() - before) / count
  assert.ok(each < 3_000, `a z.string() holds ${each.toFixed(0)} bytes, under 3 KB`)
  void kept.length
  console.log(`zod patch: a z.string() holds ${each.toFixed(0)} bytes`)
}
console.log("zod patch: methods bound on first use, each behaving as zod's own, detached too")
