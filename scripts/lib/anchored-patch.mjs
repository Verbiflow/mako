// Finds a replacement written against one release's minified bytes in another release, by its shape: every short
// name the bundler chose (not a property, not an object key, not a keyword or a global) may differ, as long as each
// is used the same way throughout the anchor. Property names, strings and punctuation stay literal, so an anchor
// still names the code it stands on, and a release breaks a patch only where that code really changed.
//
// A replacement's text may use only the names its anchor binds, those its probes bind (snippets found elsewhere in
// the same file that change nothing), and names of its own that no bundle uses: Mako's start with `mako$`. Any other
// short name is refused when the patch is applied, because it would mean whatever the new release calls by it.
const LITERAL = new Set(
  "as async await break case catch class const continue default delete do else export extends false finally for function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield Map Set NaN".split(" "),
)
const SHORT = 3

/** Splits `text` into string literals and code, so names are only read from code. */
function* pieces(text) {
  let at = 0
  const quote = /["'`]/g
  for (let m; (m = quote.exec(text)); ) {
    let end = m.index + 1
    while (end < text.length && text[end] !== m[0]) end += text[end] === "\\" ? 2 : 1
    if (end >= text.length) break // an unclosed quote in a fragment: the rest is code
    yield { code: text.slice(at, m.index) }
    yield { string: text.slice(m.index, end + 1) }
    at = end + 1
    quote.lastIndex = at
  }
  yield { code: text.slice(at) }
}

/** The bundler's names in `text`, each with where it is: short, and not a property, an object key or a keyword. */
export function minifiedNames(text) {
  const found = []
  let offset = 0
  for (const piece of pieces(text)) {
    if (piece.code !== undefined) {
      for (const m of piece.code.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const name = m[0]
        const before = piece.code[m.index - 1]
        const after = piece.code[m.index + name.length]
        const property = before === "." && piece.code[m.index - 2] !== "."
        const key = after === ":" && (before === "{" || before === ",")
        if (name.length > SHORT || LITERAL.has(name) || property || key) continue
        found.push({ name, at: offset + m.index })
      }
    }
    offset += (piece.code ?? piece.string).length
  }
  return found
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A regex matching `literal` with its minified names free but consistent, and which group holds each. */
export function anchorPattern(literal) {
  const groups = new Map()
  let source = ""
  let at = 0
  for (const { name, at: where } of minifiedNames(literal)) {
    source += escape(literal.slice(at, where))
    if (groups.has(name)) source += `\\k<${groups.get(name)}>`
    else {
      const group = `n${groups.size}`
      groups.set(name, group)
      // Not part of a longer name on either side.
      source += `(?<![\\w$])(?<${group}>[A-Za-z_$][\\w$]*)(?![\\w$])`
    }
    at = where + name.length
  }
  return { regex: new RegExp(source + escape(literal.slice(at)), "g"), groups }
}

/** Finds `literal` by shape in `source`: how many times, and for one match where and the names there, old to new. */
export function locate(source, literal) {
  const { regex, groups } = anchorPattern(literal)
  const hits = [...source.matchAll(regex)]
  if (hits.length !== 1) return { count: hits.length }
  const names = new Map([...groups].map(([name, group]) => [name, hits[0].groups[group]]))
  return { count: 1, index: hits[0].index, length: hits[0][0].length, names }
}

/** `text` with each minified name in `names` replaced; properties, keys, strings and long names untouched. */
export function rename(text, names) {
  let out = ""
  let at = 0
  for (const { name, at: where } of minifiedNames(text)) {
    if (!names.has(name)) continue
    out += text.slice(at, where) + names.get(name)
    at = where + name.length
  }
  return out + text.slice(at)
}

/**
 * A site's names in `source`: its anchor's, then its probes' for names the anchor lacks. Answers the problems
 * instead when the anchor or a probe isn't found once.
 */
export function bind(source, { from, binds = [] }) {
  const hit = locate(source, from)
  if (hit.count !== 1) return { problems: [`${hit.count === 0 ? "gone" : `found ${hit.count} times`}: ${from.slice(0, 100)}`] }
  const problems = []
  for (const probe of binds) {
    const bound = locate(source, probe)
    if (bound.count !== 1) problems.push(`probe ${bound.count === 0 ? "gone" : `found ${bound.count} times`}: ${probe.slice(0, 100)}`)
    else for (const [old, now] of bound.names) if (!hit.names.has(old)) hit.names.set(old, now)
  }
  return problems.length ? { problems } : hit
}

/**
 * `to` in this release's names. Throws when it uses a name nothing binds: in this release that name is whatever
 * the bundler gave it to (1.4.1's retry loop moved the attempt counter off `y` and put the action there).
 */
export function translate(to, names, label) {
  const taken = new Map([...names].filter(([old, now]) => old !== now).map(([old, now]) => [now, old]))
  for (const { name } of minifiedNames(to)) {
    if (names.has(name)) continue
    const now = taken.has(name) ? `, and in this release ${name} is what ${taken.get(name)} was` : ""
    throw new Error(`${label}: the replacement uses ${name}, which neither its anchor nor a probe binds${now}; bind it with a probe, or name a local of the patch's own mako$${name}`)
  }
  return rename(to, names)
}

/**
 * Applies `sites` ({ from, to, binds, label }, written against a known release) to `source`. Every anchor and probe
 * is found in `source` as given, before any change. Throws naming each site whose anchor, probe or names are gone,
 * by its label.
 */
export function applyAnchored(source, sites) {
  const found = []
  const problems = []
  for (const site of sites) {
    const hit = bind(source, site)
    if (hit.problems) {
      problems.push(...hit.problems.map((problem) => `${site.label}: ${problem}`))
      continue
    }
    try {
      found.push({ ...hit, text: translate(site.to, hit.names, site.label), site })
    } catch (cause) {
      problems.push(cause.message)
    }
  }
  if (problems.length) throw new Error(problems.join("\n"))
  found.sort((a, b) => b.index - a.index)
  for (let i = 1; i < found.length; i++)
    if (found[i].index + found[i].length > found[i - 1].index) throw new Error(`${found[i].site.label} and ${found[i - 1].site.label}: their anchors overlap`)
  let out = source
  for (const hit of found) out = out.slice(0, hit.index) + hit.text + out.slice(hit.index + hit.length)
  const renamed = new Map()
  for (const hit of found) for (const [old, now] of hit.names) if (old !== now) renamed.set(old, now)
  return { source: out, renamed: [...renamed].map(([old, now]) => `${old}->${now}`) }
}
