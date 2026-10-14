import type { ToolKind } from "@mako/sessions/tool-identity"

/*
 * Calls that only read. A change while one runs is someone else's: the
 * person saving while the agent runs `git status`, a formatter on save
 * during an `rg`. Waiting on a child agent or a background command is not
 * reading: the work waited on writes. A command line is read-only only when
 * every part of it is an inspection Mako knows, with nothing redirected into
 * a file, no heredoc, no subshell; anything else may write.
 */

const READ_ONLY_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["read", "list", "search", "find", "web-fetch", "web-search", "todo", "plan", "plan-exit", "question", "tool-search", "think", "mode", "agents"])

/** Programs that read and print, whatever their arguments but the ones `WRITES_WITH` names. */
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "fd", "tree", "pwd", "echo", "printf", "sleep", "which", "type", "file",
  "stat", "du", "df", "ps", "jq", "uniq", "cut", "tr", "diff", "cmp", "date", "uname", "true", "false", "nl", "column", "basename",
  "dirname", "realpath", "readlink", "test", "[", "cd", "find", "sed", "awk", "sort", "lsof", "whoami", "id", "hostname", "less", "more", "od", "xxd", "hexdump", "shasum", "md5", "sha256sum",
])
/** Arguments that make a reader write. */
const WRITES_WITH = new Map<string, RegExp>([
  ["find", /(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/],
  ["sed", /(^|\s)(-[a-zA-Z]*i|--in-place)/],
  ["awk", /system\s*\(|print\s*>|\|\s*getline/],
  ["sort", /(^|\s)(-o|--output)\b/],
  ["jq", /(^|\s)(-i|--in-place)\b/],
])
/** Git subcommands that only read. */
const GIT_READERS = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "cat-file", "shortlog", "rev-list", "merge-base", "name-rev", "for-each-ref", "show-ref", "whatchanged"])
/** Redirection into anything but the void. */
const REDIRECT = /(^|[^0-9&])>{1,2}(?!\s*(\/dev\/null|&[12]))|&>(?!\s*\/dev\/null)/

/** Whether a call of this kind, running this command, only reads. */
export function readOnlyCall(kind: ToolKind | undefined, command?: string): boolean {
  if (kind && READ_ONLY_KINDS.has(kind)) return true
  return kind === "shell" && command !== undefined && readOnlyCommand(command)
}

export function readOnlyCommand(command: string): boolean {
  const line = command.trim()
  if (!line || line.length > 4_000) return false
  if (/<<|\$\(|`|\btee\b|\bxargs\b|\beval\b|\bsource\b|^\.\s/.test(line) || REDIRECT.test(line)) return false
  return line.split(/&&|\|\||[;|\n]/).every((part) => readOnlyPart(part.trim()))
}

function readOnlyPart(part: string): boolean {
  if (!part) return true
  const words = part.split(/\s+/)
  // Variable assignments before the program (`LC_ALL=C sort`).
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
  const [program, ...rest] = words
  if (!program) return true
  const name = program.split("/").at(-1)!
  if (name === "git") {
    const sub = rest.find((word) => !word.startsWith("-") && !/^(-C|-c)$/.test(word))
    // A bare `git stash` pushes; only its `list` and `show` read.
    if (sub === "stash") return rest.some((word) => word === "list" || word === "show") && rest.every((word) => word === sub || word === "list" || word === "show" || word.startsWith("-") || /^stash@\{\d+\}$/.test(word))
    if (sub === "branch" || sub === "remote" || sub === "tag" || sub === "config") return rest.every((word) => word === sub || /^(-a|-r|-v|-vv|--list|--show-current|--get|--get-all|-l)$/.test(word) || word.startsWith("--format"))
    return sub !== undefined && GIT_READERS.has(sub)
  }
  if (!READERS.has(name)) return false
  const writes = WRITES_WITH.get(name)
  return !writes || !writes.test(rest.join(" "))
}
