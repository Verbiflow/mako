import assert from "node:assert/strict"
import {
  componentFrame,
  elementLabel,
  parseStack,
  resolveScriptPosition,
  sourceFileName,
} from "../dist/browser/index.js"

/* The element picker's Node half: reading React's owner stack, choosing the
 * component's own frame, naming source files the way bundlers write them,
 * reading a real source map back, and the chip's label. The page half runs
 * in Chromium: scripts/test-element-pick.ts. */


const react19 = `Error: react-stack-top-frame
    at exports.jsxDEV (http://127.0.0.1:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c:250:30)
    at PlanCard (http://127.0.0.1:5173/src/PlanCard.tsx:21:31)
    at react-stack-bottom-frame (http://127.0.0.1:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c:17424:20)
    at renderWithHooks (http://127.0.0.1:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c:4206:24)`
const frames = parseStack(react19)
assert.equal(frames.length, 4, "every V8 frame line is read")
assert.deepEqual(frames[0], { name: "exports.jsxDEV", url: "http://127.0.0.1:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b3c", line: 250, column: 30 })
assert.deepEqual(componentFrame(frames), { name: "PlanCard", url: "http://127.0.0.1:5173/src/PlanCard.tsx", line: 21, column: 31 }, "the JSX frame, never stack[0] (jsxDEV), is the component's own code")
assert.equal(componentFrame(parseStack("Error: react-stack-top-frame\n    at UnknownOwner (http://x/node_modules/react/cjs/react-jsx-dev-runtime.development.js:1:1)\n    at App (http://x/src/App.tsx:3:4)")), undefined, "React's placeholder stack names no source")
assert.deepEqual(parseStack("PlanCard@http://localhost:3000/_next/static/chunks/app_page.js:12:9\njsx@http://localhost:3000/_next/static/chunks/node_modules_react.js:1:2"), [
  { name: "PlanCard", url: "http://localhost:3000/_next/static/chunks/app_page.js", line: 12, column: 9 },
  { name: "jsx", url: "http://localhost:3000/_next/static/chunks/node_modules_react.js", line: 1, column: 2 },
], "WebKit frames read too")
assert.equal(componentFrame(parseStack("Error\n    at Card (http://localhost:3000/_next/static/chunks/framework-abc.js:1:2)\n    at Page (webpack-internal:///(app-pages-browser)/./app/page.tsx:9:3)\n    at Hero (http://localhost:3000/_next/static/chunks/app/page.js:40:7)"))?.name, "Hero", "framework chunks and non-http frames are skipped")
for (const [raw, base, expected] of [
  ["webpack://_N_E/./app/page.tsx?3f1a", undefined, "app/page.tsx"],
  ["webpack:///./src/components/Card.tsx", undefined, "src/components/Card.tsx"],
  ["turbopack:///[project]/app/pricing/page.tsx", undefined, "app/pricing/page.tsx"],
  ["/@fs/Users/me/app/src/Card.tsx", undefined, "/Users/me/app/src/Card.tsx"],
  ["http://127.0.0.1:5173/src/PlanCard.tsx?t=1712", undefined, "src/PlanCard.tsx"],
  ["PlanCard.tsx", "http://127.0.0.1:5173/src/PlanCard.tsx", "src/PlanCard.tsx"],
  ["/Users/me/app/src/My%20Card.tsx", undefined, "/Users/me/app/src/My Card.tsx"],
  ["file:///home/me/app/src/a.jsx", undefined, "/home/me/app/src/a.jsx"],
])
  assert.equal(sourceFileName(raw, base), expected, `${raw} names ${expected}`)
assert.equal(elementLabel({ component: "PlanCard", tag: "button", name: "Start a trial" }), "PlanCard")
assert.equal(elementLabel({ tag: "button", id: "save" }), "button#save")
assert.equal(elementLabel({ tag: "button", name: "Start a trial" }), "button “Start a trial”")
assert.equal(elementLabel({ tag: "div", hint: "div.card" }), "div.card")
{
  const long = elementLabel({ tag: "p", name: "A paragraph that goes on far longer than any chip should ever read" })
  assert.ok(long.length <= 40 && long.endsWith("…"), `a label is at most 40 characters: ${long}`)
}

// A real source map, made by esbuild from TSX the way a dev server serves it,
// read back through data: URLs that Node's fetch answers like a server would.
{
  const { transform } = await import("esbuild")
  const original = `type Props = { label: string }\n\nexport function Save({ label }: Props) {\n  const text: string = label.toUpperCase()\n  return <button className="save">{text}</button>\n}\n`
  const built = await transform(original, { loader: "tsx", jsx: "automatic", jsxDev: true, sourcemap: "inline", sourcefile: "/src/Save.tsx" })
  const lines = built.code.split("\n")
  const line = lines.findIndex((text) => text.includes("jsxDEV(\"button\""))
  assert.ok(line >= 0, "the compiled module calls jsxDEV for the button")
  const column = lines[line].indexOf("jsxDEV(\"button\"") + 1
  const url = `data:text/javascript;base64,${Buffer.from(built.code).toString("base64")}`
  const position = await resolveScriptPosition({ url, line: line + 1, column }, 2_000)
  assert.equal(position.kind, "mapped", JSON.stringify(position))
  if (position.kind === "mapped") {
    assert.equal(sourceFileName(position.source), "src/Save.tsx")
    assert.equal(position.line, 5, "the button's JSX is on line 5 of the TSX")
    assert.equal(position.column, 10, "and starts at its `<`")
  }
  const plain = await resolveScriptPosition({ url: `data:text/javascript;base64,${Buffer.from("export const a = 1\n").toString("base64")}`, line: 1, column: 1 }, 2_000)
  assert.deepEqual(plain, { kind: "unmapped" }, "a script without a map is its own source")
  const unreachable = await resolveScriptPosition({ url: "http://127.0.0.1:9/nothing.js", line: 1, column: 1 }, 500)
  assert.equal(unreachable.kind, "failed", "a script that can't be fetched fails within its budget")
}
console.log("Element pick: stacks, source maps, file names and labels read as expected")

