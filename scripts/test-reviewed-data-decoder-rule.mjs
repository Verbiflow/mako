import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

// Real oxlint AST/scope execution, using the same rules and explicit policy as normal lint.
const root = resolve(import.meta.dirname, "..")
const module = "packages/protocol/src/handoff-project.ts"
const reviewedDataDecoder = { module, export: "plainProtocolValue", result: "PlainProtocolValue" }
const plugin = join(root, "tools/oxlint/anti-slop/index.ts")
const decoder = `
export type PlainProtocolValue = string | number | boolean | null | PlainProtocolValue[]
export function plainProtocolValue(input: unknown): PlainProtocolValue {
  const copy = (value: unknown, depth: number): PlainProtocolValue => {
    if (typeof value === "string") return value
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value
    if (typeof value !== "object") throw new Error("bad-input")
    const length = 0
    if (typeof length !== "number") throw new Error("bad-input")
    for (const key of []) if (typeof key !== "string") throw new Error("bad-input")
    if (depth > 0) return null
    return copy(value, depth + 1)
  }
  return copy(input, 0)
}
`
const unknown = "anti-slop(no-unknown-parameters)"
const typeofCode = "anti-slop(no-runtime-typeof)"
const unknownReturn = "anti-slop(no-unknown-returns)"
const counts = (inputs = 0, classifications = 0, returns = 0) => ({ [unknown]: inputs, [typeofCode]: classifications, [unknownReturn]: returns })
const addInside = source => decoder.replace('    if (depth > 0)', `${source}\n    if (depth > 0)`)
const canonical = await readFile(join(root, module), "utf8")
const addCanonical = source => canonical.replace('    return output\n  }', `${source}\n    return output\n  }`)
const cases = [
  { name: "canonical block length shadow", source: addCanonical('    { const length = 1; if (typeof length === "number") return null }'), expected: counts(0, 1) },
  { name: "canonical nested loop key shadow", source: addCanonical('    { for (const key of []) if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "canonical catch value shadow", source: addCanonical('    try { throw null } catch (value) { if (typeof value === "object") return null }'), expected: counts(0, 1) },
  { name: "canonical destructured length shadow", source: addCanonical('    { const [length] = [1]; if (typeof length === "number") return null }'), expected: counts(0, 1) },
  { name: "canonical ambiguous length roles fail closed", source: addCanonical('    const length = 1; if (typeof length === "number") return null'), expected: counts(0, 2) },

  // These three controls are unchanged from the independent review fixture.
  { name: "block shadow of raw value", source: addInside('    { const value = {}; if (typeof value === "object") return null }'), expected: counts(0, 1) },
  { name: "catch shadow of raw value", source: addInside('    try { throw null } catch (value) { if (typeof value === "object") return null }'), expected: counts(0, 1) },
  { name: "nested shadow of own key", source: addInside('    { const key = "unrelated"; if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "block shadow of length", source: addInside('    { const length = 1; if (typeof length === "number") return null }'), expected: counts(0, 1) },
  { name: "nested for-of key", source: addInside('    { for (const key of []) if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "nested key loop inside approved loop", source: decoder.replace('if (typeof key !== "string") throw new Error("bad-input")', '{ if (typeof key !== "string") throw new Error("bad-input"); for (const key of []) if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "catch shadow of length", source: addInside('    try { throw 1 } catch (length) { if (typeof length === "number") return null }'), expected: counts(0, 1) },
  { name: "catch shadow of key", source: addInside('    try { throw "x" } catch (key) { if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "destructured value binding", source: addInside('    { const { value } = { value: "x" }; if (typeof value === "string") return null }'), expected: counts(0, 1) },
  { name: "destructured key binding", source: addInside('    { const { key } = { key: "x" }; if (typeof key === "string") return null }'), expected: counts(0, 1) },
  { name: "destructured catch value", source: addInside('    try { throw { value: "x" } } catch ({ value }) { if (typeof value === "string") return null }'), expected: counts(0, 1) },
  { name: "for-of raw parameter shadow", source: addInside('    for (const value of []) if (typeof value === "object") return null'), expected: counts(0, 1) },
  { name: "nested length loop", source: addInside('    for (const length of []) if (typeof length === "number") return null'), expected: counts(0, 1) },
  { name: "unresolved length", source: decoder.replace("const length = 0", "const otherLength = 0"), expected: counts(0, 1) },
  { name: "unresolved key", source: decoder.replace("const key of []", "const otherKey of []"), expected: counts(0, 1) },
  { name: "ambiguous key roles fail closed", source: addInside('    for (const key of []) if (typeof key === "string") return null'), expected: counts(0, 2) },

  { name: "exact exported decoder and recursive helper", source: decoder, expected: counts() },
  { name: "actual canonical source", source: await readFile(join(root, module), "utf8"), expected: counts() },
  { name: "same names elsewhere", file: "packages/protocol/src/other.ts", source: decoder, expected: counts(2, 6) },
  { name: "module suffix lookalike", file: `elsewhere/${module}`, source: decoder, expected: counts(2, 6) },
  { name: "module filename lookalike", file: `${module}.ts`, source: decoder, expected: counts(2, 6) },
  { name: "export name lookalike", source: decoder.replace("function plainProtocolValue", "function plainProtocolValues"), expected: counts(2, 6) },
  { name: "nonexported", source: decoder.replace("export function", "function"), expected: counts(2, 6) },
  { name: "default export", source: decoder.replace("export function", "export default function"), expected: counts(2, 6) },
  { name: "mismatched root result", source: decoder.replace("input: unknown): PlainProtocolValue", "input: unknown): string"), expected: counts(2, 6) },
  { name: "unknown root result", source: decoder.replace("input: unknown): PlainProtocolValue", "input: unknown): unknown"), expected: counts(2, 6, 1) },
  { name: "unknown helper result", source: decoder.replace("depth: number): PlainProtocolValue", "depth: number): unknown"), expected: counts(1, 6, 1) },
  { name: "extra root unknown parameter", source: decoder.replace("input: unknown", "input: unknown, extra: unknown"), expected: counts(3, 6) },
  { name: "wrong helper depth", source: decoder.replace("depth: number", "depth: string"), expected: counts(1, 6) },
  { name: "nonrecursive helper", source: decoder.replace("return copy(value, depth + 1)", "return null"), expected: counts(1, 6) },
  { name: "indirect helper", source: decoder.replace("  const copy =", "  { const copy =").replace("  return copy(input, 0)", "  return copy(input, 0) }"), expected: counts(1, 6) },
  { name: "sibling helper", source: decoder + '\nfunction sibling(value: unknown): string { return typeof value }', expected: counts(1, 1) },
  { name: "moved copy helper", source: decoder + '\nconst copy = (value: unknown, depth: number): PlainProtocolValue => typeof value === "string" ? value : copy(value, depth + 1)', expected: counts(1, 1) },
  { name: "unrelated nested callback", source: addInside('    const unrelated = (value: unknown): string => typeof value'), expected: counts(1, 1) },
  { name: "nested copy callback", source: addInside('    const wrapper = () => { const copy = (value: unknown, depth: number): PlainProtocolValue => typeof value === "string" ? value : copy(value, depth + 1) }'), expected: counts(1, 1) },
  { name: "method signature", source: addInside('    type Methods = { copy(value: unknown): unknown }'), expected: counts(1, 0, 1) },
  { name: "unrelated helper unknown return", source: addInside('    const unrelated = (): unknown => null'), expected: counts(0, 0, 1) },
  { name: "unknown output alias", source: decoder.replace("string | number | boolean | null | PlainProtocolValue[]", "unknown"), expected: counts(0, 0, 2) },
  { name: "unnecessary typeof operand", source: addInside('    const other = 1; if (typeof other === "number") return null'), expected: counts(0, 1) },
  { name: "unnecessary classification", source: addInside('    if (typeof value === "function") return null'), expected: counts(0, 1) },
  { name: "bare typeof", source: addInside('    const representation = typeof value'), expected: counts(0, 1) },
  { name: "root unrelated callback", source: decoder.replace("  return copy(input, 0)", '  const unrelated = (input: unknown) => typeof input\n  return copy(input, 0)'), expected: counts(1, 1) },
  { name: "default policy remains strict", source: decoder, configured: false, expected: counts(2, 6) },
  { name: "default unknown input", source: 'function domain(value: unknown): string { return "x" }', expected: counts(1) },
  { name: "default cause exception", source: 'function error(cause: unknown): void {}', configured: false, expected: counts() },
  { name: "default typeof", source: 'const tag = typeof 1', configured: false, expected: counts(0, 1) },
  { name: "default type guard remains strict", source: 'function isString(value: string | number): value is string { return typeof value === "string" }', configured: false, expected: counts(0, 1) },
  { name: "existing explicit type guard option", source: 'function isString(value: string | number): value is string { return typeof value === "string" }', configured: false, allowInTypeGuards: true, expected: counts() },
]
const scratch = await mkdtemp(join(tmpdir(), "mako-decoder-rule-"))
try {
  for (const [index, test] of cases.entries()) {
    const cwd = join(scratch, String(index))
    const file = join(cwd, test.file ?? module)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, test.source)
    const option = test.configured === false ? {} : { reviewedDataDecoder }
    await writeFile(join(cwd, ".oxlintrc.json"), JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [{ name: "anti-slop", specifier: plugin }],
      rules: {
        "anti-slop/no-unknown-parameters": ["error", option],
        "anti-slop/no-runtime-typeof": ["error", { ...option, allowInTypeGuards: test.allowInTypeGuards ?? false }],
        "anti-slop/no-unknown-returns": "error",
      },
    }))
    const result = spawnSync(join(root, "node_modules/.bin/oxlint"), ["--config", ".oxlintrc.json", "--format", "json", test.file ?? module], { cwd, encoding: "utf8", timeout: 10000 })
    assert.ifError(result.error)
    assert.equal(result.signal, null, test.name)
    const diagnostics = JSON.parse(result.stdout).diagnostics
    const found = counts()
    for (const diagnostic of diagnostics) {
      assert.ok(Object.hasOwn(found, diagnostic.code), `${test.name}: unexpected ${JSON.stringify(diagnostic)}`)
      found[diagnostic.code]++
    }
    assert.deepEqual(found, test.expected, test.name)
    assert.equal(result.status, Object.values(test.expected).some(Boolean) ? 1 : 0, `${test.name}: ${result.stderr}`)
    console.log(`PASS: ${test.name}`)
  }
  console.log(`PASS: ${cases.length} reviewed-boundary policy cases, real oxlint AST and lexical scopes`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
await assert.rejects(readFile(scratch), { code: "ENOENT" })
