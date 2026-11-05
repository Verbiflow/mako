#!/usr/bin/env node
/**
 * The design system's rules a stylesheet can break (`docs/design.md`), checked over every CSS file under `src`:
 *
 * - colour comes from tokens: a raw colour (hex, rgb, hsl, oklch) only in a custom property's declaration, or as
 *   the black or white of a mask, a shadow or a scrim;
 * - every corner is square: a `border-radius` is 0, a radius token, `inherit`, or what means a dot or a pill
 *   (50%, 999px, 9999px), or a hairline's 1-2px on a bar;
 * - the old accent is gone: nothing named ember.
 *
 * Run by `npm run lint`; `node scripts/check-design-tokens.mjs` alone prints each break with its line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const root = new URL("..", import.meta.url).pathname
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith(".css")) files.push(path)
  }
}
walk(join(root, "src"))

const RAW = /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?)\(/
const NEUTRAL = /#000(?:000)?\b|#fff(?:fff)?\b|\b(?:rgba?)\(\s*(?:0[ ,]+0[ ,]+0|255[ ,]+255[ ,]+255)\b|\boklch\(\s*(?:0|1)\s+0\s+0\b|transparent/g
const NEUTRAL_USE = /^\s*(?:mask|mask-image|-webkit-mask|-webkit-mask-image|box-shadow|text-shadow|filter|background|background-color|background-image)\s*:/
const RADIUS = /^\s*border-(?:top-|bottom-)?(?:left-|right-|start-|end-)?(?:start-|end-)?radius\s*:\s*([^;]+);?/
const ROUND = /^(?:0(?:px)?|var\(--radius[\w-]*\)|inherit|50%|999px|9999px|[12](?:\.5)?px|calc\(var\(--radius[\w-]*\)[^)]*\))$/

const breaks = []
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n")
  let comment = false
  // The property a line belongs to: its own, or the one a declaration spanning several lines opened.
  let property = ""
  lines.forEach((raw, index) => {
    let line = raw
    if (comment) {
      const end = line.indexOf("*/")
      if (end < 0) return
      line = line.slice(end + 2)
      comment = false
    }
    line = line.replace(/\/\*.*?\*\//g, "")
    const open = line.indexOf("/*")
    if (open >= 0) {
      line = line.slice(0, open)
      comment = true
    }
    const at = `${relative(root, file)}:${index + 1}`
    const opened = /^\s*(--[\w-]+|[a-z-]+)\s*:(?!:)/.exec(line)
    if (opened) property = opened[1]
    const own = property
    if (/[;{}]\s*$/.test(line)) property = ""
    if (/ember/i.test(line) && !/remember|member/i.test(line)) breaks.push(`${at}  the old accent ("ember") is gone; use the tokens`)
    const radius = RADIUS.exec(line)
    if (radius && !radius[1].trim().split(/\s+/).every((part) => ROUND.test(part))) breaks.push(`${at}  every corner is square: ${line.trim()}`)
    if (own.startsWith("--")) return
    if (!RAW.test(line)) return
    const rest = line.replace(NEUTRAL, "")
    if (NEUTRAL_USE.test(`${own}:`) && !RAW.test(rest)) return
    breaks.push(`${at}  colour comes from tokens: ${line.trim()}`)
  })
}

if (breaks.length) {
  console.error(`Design tokens: ${breaks.length} break${breaks.length === 1 ? "" : "s"} (docs/design.md)\n${breaks.join("\n")}`)
  process.exit(1)
}
console.log(`Design tokens: ${files.length} stylesheets keep to the tokens and square corners`)
