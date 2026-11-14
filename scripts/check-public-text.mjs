import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * Everything committed here is public, and so are commit messages and pull
 * requests. This fails a change that adds what names a machine or the hosted
 * service: a home folder (`/Users/<name>`, `/home/<name>`, as harnesses also
 * fold it into `-Users-<name>-…` or `%2FUsers%2F<name>`), macOS's per-user
 * temporary folder, a personal email address, or a name from
 * `public-text-denylist.txt`. Only lines a change adds count, never ones it
 * keeps or removes. It says where and what kind, never the value: CI logs are
 * public too.
 *
 *   node scripts/check-public-text.mjs <base> <head>
 *   node scripts/check-public-text.mjs --event "$GITHUB_EVENT_PATH"
 *
 * reads the added lines of `<base>...<head>`, the file names it adds and the
 * messages of `<base>..<head>`; given a pull request's event, its base, head,
 * title and body. The title and body come from the event's file, never the
 * step's environment, which Actions prints in the log.
 */

/** Files that must spell what they check for: the denylist and this check's own test. */
export const EXEMPT = new Set(["scripts/public-text-denylist.txt", "scripts/test-public-text.mjs"])
/** A lockfile is written by npm, and keeps the addresses packages publish. */
const LOCKFILE = /(?:^|\/)package-lock\.json$/

/**
 * Home folders anyone may name: the placeholders tests, docs and fixtures use, the stand-in
 * `fixture-privacy.ts` scrubs to, CI's and containers' accounts. A suffix ("ada-canary", "tester0") keeps it one.
 */
const PLACEHOLDER_NAMES = [
  "me", "you", "someone", "somebody", "user", "username", "name", "person", "example", "test", "tester", "fixture",
  "mock", "dev", "developer", "admin", "mako", "node", "ubuntu", "runner", "root", "guest", "shared", "nothing",
  "ana", "ada", "bob", "bo", "alice", "sam",
]
const PLACEHOLDER = new RegExp(`^(?:[A-Za-z]|(?:${PLACEHOLDER_NAMES.join("|")})(?:\\d+|(?:[-_.][A-Za-z0-9]+)+)?)$`, "i")

/** A home folder as a path (after anything but a path's own characters, so `src/home/x.ts` isn't one), as Claude names a project's folder for it, and URL-encoded. */
const HOME_FORMS = [
  /(?<![A-Za-z0-9._~/\\-])(?:[A-Za-z]:)?[/\\]+(?:Users|home)[/\\]+([A-Za-z][A-Za-z0-9._-]*)/g,
  /(?<=^|[/\\"'`\s(=:])-(?:Users|home)-([A-Za-z][A-Za-z0-9._-]*)/g,
  /(?<![A-Za-z0-9._~-])%2F(?:Users|home)%2F([A-Za-z][A-Za-z0-9._-]*)/gi,
]
/** macOS's per-user temporary folder (`$TMPDIR`), in any of the spellings above. */
const TEMP_FOLDER = /(?:\/|%2F|-)var(?:\/|%2F|-)folders(?:\/|%2F|-)/gi

const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,}))(?![A-Za-z0-9-])/g
/** Domains for documentation and tests (RFC 2606, RFC 6761). */
const PLACEHOLDER_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[^.]+\.(?:example|invalid|test|localhost|local))$/i
/** What reads like an address but is a file: `native-1@launch-1.jsonl`, `icon@2x.png`. */
const FILE_EXTENSIONS = new Set(["json", "jsonl", "ndjson", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "mp4", "webm", "mov", "ts", "tsx", "mts", "js", "mjs", "cjs", "md", "txt", "log", "patch", "diff", "lock", "yml", "yaml", "toml", "sh", "py", "html", "css", "map", "zip", "gz", "tgz", "pdf", "db"])

/** Coding agents' own addresses, which their `Co-authored-by` trailers carry. */
const AGENT_ADDRESSES = new Set(["cursoragent@cursor.com"])

/** An SSH remote, `git@github.com:owner/repo` or `ssh://git@github.com/owner/repo`, by what's around its `git@host`. */
const sshRemote = (before, after) => /^:[A-Za-z0-9._~-]+\//.test(after) || (before.endsWith("ssh://") && /^\/[A-Za-z0-9._~-]/.test(after))

function allowedEmail(local, domain, tld, before, after) {
  if (FILE_EXTENSIONS.has(tld.toLowerCase())) return true
  if (/no-?reply/i.test(local) || /(?:^|\.)users\.noreply\.github\.com$/i.test(domain)) return true
  if (AGENT_ADDRESSES.has(`${local}@${domain}`.toLowerCase())) return true
  if (local === "git" && sshRemote(before, after)) return true
  return PLACEHOLDER_DOMAIN.test(domain)
}

/**
 * Whether a home folder's name is a placeholder, or a file's (`/home/pace.jsonl`, the path's last part and no folder
 * of anything, unless `strict`): in a folded form (`-Users-ada-work-app`) it is the first word.
 */
function allowedHome(name, folded, after, strict) {
  const trimmed = name.replace(/[._-]+$/, "")
  const last = !/^(?:[/\\]|%2F)/i.test(after)
  if (!strict && !folded && last && FILE_EXTENSIONS.has(/\.([A-Za-z0-9]+)$/.exec(trimmed)?.[1]?.toLowerCase() ?? "")) return true
  return PLACEHOLDER.test(folded ? (trimmed.split("-")[0] ?? "") : trimmed)
}

/** One line of the denylist: a whole word in any case, or a `/regular expression/`. */
export function denylistPatterns(text) {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    if (line.length > 2 && line.startsWith("/") && line.endsWith("/")) return new RegExp(line.slice(1, -1), "g")
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "gi")
  })
}

const DENYLIST = denylistPatterns(readFileSync(new URL("public-text-denylist.txt", import.meta.url), "utf8"))

/** What `text` holds that public text may not, each with its column (1-based), by kind and never by value. `strict` takes a home folder that reads as a file for one. */
export function findLeaks(text, denylist = DENYLIST, { strict = false } = {}) {
  const found = []
  const after = (match) => text.slice(match.index + match[0].length)
  for (const [index, pattern] of HOME_FORMS.entries())
    for (const match of text.matchAll(pattern)) {
      if (!allowedHome(match[1] ?? "", index === 1, after(match), strict)) found.push({ column: match.index + 1, kind: "home path" })
    }
  for (const match of text.matchAll(TEMP_FOLDER)) found.push({ column: match.index + 1, kind: "temporary folder" })
  for (const match of text.matchAll(EMAIL))
    if (!allowedEmail(match[1] ?? "", match[2] ?? "", match[3] ?? "", text.slice(0, match.index), after(match))) found.push({ column: match.index + 1, kind: "email" })
  for (const pattern of denylist) for (const match of text.matchAll(pattern)) found.push({ column: match.index + 1, kind: "hosted name" })
  return found.sort((a, b) => a.column - b.column)
}

function unquote(path) {
  return path.startsWith('"') ? JSON.parse(path) : path
}

/**
 * The lines a unified diff adds, by file and line, and the files it creates (a rename is one, read `--no-renames`),
 * each with its file's place in the diff (from 1, as `git diff --name-only` lists them). Each hunk is read by its own
 * line counts, so an added line that starts with `+++` is a line, not a header.
 */
export function addedLines(diff) {
  const lines = []
  const files = []
  let file
  let index = 0
  let created = false
  let added = 0
  let removed = 0
  let line = 0
  for (const text of diff.split("\n")) {
    if (added > 0 || removed > 0) {
      if (text.startsWith("+")) {
        if (file) lines.push({ file, index, line, text: text.slice(1) })
        line++
        added--
      } else if (text.startsWith("-")) removed--
      else if (!text.startsWith("\\")) {
        line++
        added--
        removed--
      }
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (hunk) {
      removed = Number(hunk[1] ?? 1)
      line = Number(hunk[2])
      added = Number(hunk[3] ?? 1)
    } else if (text.startsWith("+++ ")) {
      const target = unquote(text.slice(4))
      file = target === "/dev/null" ? undefined : target.replace(/^b\//, "")
      if (file && created) files.push({ file, index })
    } else if (text.startsWith("new file mode ")) created = true
    else if (text.startsWith("diff --git ")) {
      file = undefined
      index++
      created = false
    }
  }
  return { lines, files }
}

const git = (args, cwd) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 30 })

/** Every place a change from `base` to `head` adds what public text may not, as `where: kind` lines. */
export function changeLeaks(base, head, { cwd = process.cwd(), title = "", body = "" } = {}) {
  const out = []
  const { lines, files } = addedLines(git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", `${base}...${head}`], cwd))
  // A name is read as the path it is from the repository's root, where `Users/<name>/x.md` lies.
  const nameLeaks = (file) => findLeaks(`/${file}`)
  // What a line may say a log may not repeat: a name with any `@` in it, even one that reads as a file's
  // (`<address>.md`), or that holds what it may not, goes by its place in the diff.
  const named = (file) => !/@|%40/i.test(file) && !findLeaks(`/${file}`, DENYLIST, { strict: true }).length
  const where = (file, index) => (named(file) ? file : `file #${index} (name withheld)`)
  for (const { file, index } of files) if (!EXEMPT.has(file)) for (const { kind } of nameLeaks(file)) out.push(`${where(file, index)}, its name: ${kind}`)
  for (const { file, index, line, text } of lines) {
    if (EXEMPT.has(file)) continue
    for (const { column, kind } of findLeaks(text)) if (!(kind === "email" && LOCKFILE.test(file))) out.push(`${where(file, index)}:${line}:${column}: ${kind}`)
  }
  const log = git(["log", "--format=%h%x00%B%x00", `${base}..${head}`], cwd).split("\0")
  for (let at = 0; at + 1 < log.length; at += 2) {
    const commit = log[at].trim()
    log[at + 1].split("\n").forEach((text, index) => {
      for (const { column, kind } of findLeaks(text)) out.push(`commit ${commit}, message line ${index + 1}:${column}: ${kind}`)
    })
  }
  for (const [name, text] of [["title", title], ["body", body]])
    text.split("\n").forEach((line, index) => {
      for (const { column, kind } of findLeaks(line)) out.push(`pull request ${name}, line ${index + 1}:${column}: ${kind}`)
    })
  return out
}

/** A pull request's base, head, title and body, from the event GitHub writes for its workflow. */
export function pullRequestEvent(file) {
  const event = JSON.parse(readFileSync(file, "utf8"))
  const pull = event.pull_request
  if (!pull?.base?.sha || !pull?.head?.sha) throw new Error(`${file} is not a pull request's event`)
  return { base: pull.base.sha, head: pull.head.sha, title: pull.title ?? "", body: pull.body ?? "" }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const { base, head, title = "", body = "" } = args[0] === "--event" && args[1] ? pullRequestEvent(args[1]) : { base: args[0], head: args[1] }
  if (!base || !head) {
    console.error("Use: node scripts/check-public-text.mjs <base> <head>, or --event <pull request event file>")
    process.exit(2)
  }
  const leaks = changeLeaks(base, head, { title, body })
  if (leaks.length) {
    const withheld = leaks.some((leak) => leak.startsWith("file #")) ? `; file #N is line N of \`git diff --name-only --no-renames ${base}...${head}\`` : ""
    console.error(`${leaks.length} places add what public text may not (values not printed${withheld}; see scripts/check-public-text.mjs):\n${leaks.map((leak) => `  ${leak}`).join("\n")}`)
    process.exit(1)
  }
  console.log(`Nothing ${base}...${head} adds names a machine, a person's address or the hosted service`)
}
