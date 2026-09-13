/**
 * Composer references.
 *
 * `@path/to/file`, `@thread:…`, `$skill-name`, and `$mcp:server` are plain
 * text in the draft, and a draft may open with `/skill-name` the way every
 * agent CLI's slash invocation does. The selected provider receives exactly
 * what is on screen plus any prepared transcript bundles they reference. The
 * tokenizer lets the same string render as chips in the composer and in the
 * transcript.
 */

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; raw: string }
  | { kind: "thread"; harness: string; id: string; raw: string }
  | { kind: "skill"; name: string; raw: string }
  | { kind: "mcp"; name: string; raw: string }

export type CapabilityKind = "skill" | "mcp"
export type CapabilitySigil = "$" | "/"

/**
 * A file token runs to the next whitespace. Paths do not contain spaces often
 * enough to justify a quoting syntax, and a wrong split is visible and
 * immediately fixable, whereas a quoting rule is neither.
 */
const TOKEN = /(^|\s)([@$])([^\s]+)/g

/**
 * A slash invocation only counts at the very start of the draft and only
 * with a skill-shaped name, so `/Users/me/file.ts` stays a path and `/` alone
 * stays a character the user is still typing.
 */
const LEADING_SLASH = /^\/((?:mcp:)?[a-z0-9][\w.-]*)(?=\s|$)/i

const MCP_PREFIX = "mcp:"

function capabilitySegment(sigil: string, body: string): Segment {
  const raw = `${sigil}${body}`
  return body.startsWith(MCP_PREFIX)
    ? { kind: "mcp", name: body.slice(MCP_PREFIX.length), raw }
    : { kind: "skill", name: body, raw }
}

/** Split text into prose and reference segments. `leading` is false for a slice that does not start the draft. */
export function tokenize(text: string, leading = true): Segment[] {
  const segments: Segment[] = []
  let cursor = 0

  const slash = leading ? LEADING_SLASH.exec(text) : null
  if (slash?.[1]) {
    segments.push(capabilitySegment("/", slash[1]))
    cursor = slash[0].length
  }

  for (const match of text.matchAll(TOKEN)) {
    const [, lead, sigil, matchedBody] = match
    const start = (match.index ?? 0) + lead.length
    if (!matchedBody || start < cursor) continue

    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) })

    // A generated thread token is commonly followed by sentence punctuation.
    // Keep that punctuation as prose rather than folding it into the native id.
    const body =
      sigil === "@" && matchedBody.startsWith("thread:")
        ? matchedBody.replace(/[),.;!?]+$/, "")
        : matchedBody
    const raw = `${sigil}${body}`
    const thread = sigil === "@" ? parseThreadToken(body) : null
    segments.push(
      thread
        ? { kind: "thread", ...thread, raw }
        : sigil === "@"
          ? { kind: "file", path: body, raw }
          : capabilitySegment(sigil, body)
    )
    cursor = start + raw.length
  }

  if (cursor === 0) return [{ kind: "text", text }]
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) })
  return segments
}

export function hasReferences(text: string): boolean {
  TOKEN.lastIndex = 0
  return LEADING_SLASH.test(text) || TOKEN.test(text)
}

/**
 * The id a thread token carries: the provider's dedupe identity when it has
 * one, else the native id. A Cursor session continued by the CLI into
 * `chats/` shares its native id with the original store, so a token minted
 * from the native id alone would name two rows and resolve to neither.
 */
export function threadReferenceId(ref: { nativeId: string; identity?: string }): string {
  return ref.identity ?? ref.nativeId
}

export function threadToken(harness: string, id: string): string {
  // The full id keeps the token collision-safe. Older drafts containing
  // shortened ids still resolve when their prefix identifies exactly one thread.
  return `@thread:${encodeURIComponent(harness)}:${encodeURIComponent(id)}`
}

/** The text a picked skill or MCP server inserts, in the sigil the user typed. */
export function capabilityToken(
  sigil: CapabilitySigil,
  kind: CapabilityKind,
  name: string
): string {
  return `${sigil}${kind === "mcp" ? MCP_PREFIX : ""}${name}`
}

export function parseThreadToken(body: string): { harness: string; id: string } | null {
  const match = /^thread:([^:]+):(.+)$/.exec(body)
  if (!match) return null
  try {
    return { harness: decodeURIComponent(match[1]!), id: decodeURIComponent(match[2]!) }
  } catch {
    return null
  }
}

/** The reference being typed at the caret, if any. */
export interface ActiveMention {
  sigil: "@" | "$" | "/"
  query: string
  /** Offsets of the token in the source string, for replacement. */
  start: number
  end: number
}

export function mentionAt(text: string, caret: number): ActiveMention | null {
  // `/` opens a menu only while the draft is nothing but that one token, the
  // way slash commands work everywhere else; a path later in a sentence is
  // just a path.
  const head = text.slice(0, caret)
  if (/^\/[^\s]*$/.test(head)) {
    return { sigil: "/", query: head.slice(1), start: 0, end: caret }
  }

  // Scan back from the caret to the sigil, stopping at whitespace.
  let index = caret - 1
  while (index >= 0 && !/\s/.test(text[index])) {
    const char = text[index]
    if (char === "@" || char === "$") {
      // A sigil only opens a mention at a word boundary.
      const before = index === 0 ? " " : text[index - 1]
      if (!/\s/.test(before)) return null
      return {
        sigil: char,
        query: text.slice(index + 1, caret),
        start: index,
        end: caret,
      }
    }
    index -= 1
  }
  return null
}

export function replaceMention(text: string, mention: ActiveMention, value: string) {
  const inserted = `${value} `
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  }
}

/** Map a file extension to a coarse kind, for the chip glyph. */
export function fileKind(path: string): "code" | "style" | "config" | "doc" | "image" | "file" {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "rb", "java", "c", "h", "cpp", "swift", "kt", "sh"].includes(ext)) {
    return "code"
  }
  if (["css", "scss", "less", "pcss"].includes(ext)) return "style"
  if (["json", "yaml", "yml", "toml", "ini", "env", "lock"].includes(ext)) return "config"
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "doc"
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"].includes(ext)) return "image"
  return "file"
}
