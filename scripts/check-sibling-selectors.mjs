#!/usr/bin/env node
/**
 * No rule in the app's stylesheet ends in a sibling combinator before a subject with nothing to aim at: `* + *`,
 * `.list > * ~ *`, `+ :not(:first-child)`. Chromium keeps one invalidation set for all of them, and a block joining any
 * parent then restyles that parent's whole subtree: a streaming answer, 25 to 58 thousand elements a block at 250 KB
 * (`test:prose-settle-ui`). A subject with a tag, class, id or attribute (`li + li`, `.a ~ .b`) is aimed and allowed;
 * `> :where(:not(:first-child))` says the same as `> * + *` without a sibling combinator.
 *
 * The stylesheet checked is the one the window loads: `src/index.css` compiled by Tailwind over the sources it scans,
 * so a `[&>*+*]:` utility in a class name is found as well as a rule written in the file.
 *
 *   node scripts/check-sibling-selectors.mjs              check
 *   node scripts/check-sibling-selectors.mjs --test       also show it finds each kind it means to
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const entry = join(root, "src/index.css")

/** The selectors of every style rule in `css`, each one of a comma list on its own. */
export function selectors(css) {
  const found = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "")
  let start = 0
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (char === "{") {
      const prelude = text.slice(start, at).trim()
      if (prelude && !prelude.startsWith("@")) found.push(...split(prelude))
      start = at + 1
    } else if (char === "}" || char === ";") start = at + 1
  }
  return found
}

function split(list) {
  const parts = []
  let depth = 0
  let from = 0
  for (let at = 0; at < list.length; at++) {
    const char = list[at]
    if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth -= 1
    else if (char === "," && depth === 0) {
      parts.push(list.slice(from, at).trim())
      from = at + 1
    }
  }
  parts.push(list.slice(from).trim())
  return parts
}

/**
 * Whether `selector`'s subject follows a sibling combinator and has nothing but `*` and pseudo-classes: no tag, class,
 * id or attribute for Chromium to aim the invalidation at.
 */
export function unaimedSibling(selector) {
  let depth = 0
  let combinator = -1
  for (let at = 0; at < selector.length; at++) {
    const char = selector[at]
    if (char === "\\") at += 1
    else if (char === "(" || char === "[") depth += 1
    else if (char === ")" || char === "]") depth -= 1
    else if (depth === 0 && (char === "+" || char === "~" || char === ">" || char === " ")) combinator = at
  }
  if (combinator < 0) return false
  const before = selector.slice(0, combinator + 1).trimEnd()
  if (!before.endsWith("+") && !before.endsWith("~")) return false
  const subject = selector.slice(combinator + 1).trim()
  // Strip pseudo-classes and pseudo-elements with their arguments, then `*`: what's left is the subject's aim.
  let rest = ""
  for (let at = 0; at < subject.length; at++) {
    if (subject[at] === ":") {
      at += subject[at + 1] === ":" ? 1 : 0
      while (at + 1 < subject.length && /[\w-]/.test(subject[at + 1])) at += 1
      if (subject[at + 1] === "(") {
        let nested = 0
        do {
          at += 1
          if (subject[at] === "(") nested += 1
          else if (subject[at] === ")") nested -= 1
        } while (at < subject.length && nested > 0)
      }
    } else rest += subject[at]
  }
  return rest.replace(/\*/g, "").trim() === ""
}

async function appCss() {
  const compiler = await compile(readFileSync(entry, "utf8"), { base: dirname(entry), onDependency() {} })
  const sources = (compiler.root === "none" ? [] : compiler.root === null ? [{ base: root, pattern: "**/*", negated: false }] : [{ ...compiler.root, negated: false }]).concat(compiler.sources)
  return compiler.build(new Scanner({ sources }).scan())
}

if (process.argv.includes("--test")) {
  for (const bad of ["* + *", ".review-card > * + *", ".\\[\\&\\>\\*\\+\\*\\]\\:border-t > * + *", ".a ~ *", ".a + :not(:first-child)", ".a+*::before"])
    if (!unaimedSibling(bad)) throw new Error(`missed ${bad}`)
  for (const good of [".mako-prose > *", "li + li", ".review-finding + .review-finding", ".a > :where(:not(:first-child))", ".a + [data-x]", ".a:not(.b + *) > p", ".mako-prose > :first-child"])
    if (unaimedSibling(good)) throw new Error(`flagged ${good}`)
  if (selectors(".a, .b > * + * { x: y } @media (x) { .c ~ * { x: y } }").filter(unaimedSibling).length !== 2) throw new Error("missed a rule in a list or a media block")
}

const css = await appCss()
const all = selectors(css)
const found = [...new Set(all.filter(unaimedSibling))]
if (found.length) {
  console.error(`The app's stylesheet has ${found.length} sibling rule${found.length === 1 ? "" : "s"} whose subject has nothing to aim at; each one restyles a streaming answer whole for every block it gains. Write \`> :where(:not(:first-child))\` for \`> * + *\`, or give the subject a class:\n${found.map((selector) => `  ${selector}`).join("\n")}`)
  process.exit(1)
}
console.log(`Sibling selectors: none of the ${all.length} selectors in the app's compiled stylesheet ends in an unaimed sibling subject`)
