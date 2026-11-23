import { CHATS_FOLDER } from "./chat-folders.js"
import { sha256Hex } from "./sha256.js"

/**
 * A Thread's handle: a short name to say, type and paste where its title is too long or changes, `mako-7f3k`. It is
 * worked out from the Thread's ID and never kept, so every device, the cloud and a saved transcript say the same one
 * with nothing to sync; a counter per project would give two devices offline the same number.
 *
 * The part after the last hyphen is the handle: the first `HANDLE_LENGTH` characters of the Thread's code
 * (`threadCode`). The word before it is its project's folder name, there to be read: a lookup drops it, so a handle
 * written before its project was renamed, or with no word at all, still finds its Thread.
 *
 * Four characters of 31 are 923,521 handles. A Thread shares its four with another of 300 in a project 0.03% of the
 * time, and with another of 5,300 in an account 0.6%. Two that do are told apart as short commit hashes are: each has
 * its whole code behind its handle, a lookup that finds both names them a character or more longer
 * (`ThreadHandles` in the host), and the longer handle finds one. Pure, with no Node built-ins.
 */

/** Digits and lower-case letters without 0 and o, 1, l and i, which read alike aloud and in most typefaces. */
export const HANDLE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
/** The characters of its code a Thread's handle shows. */
export const HANDLE_LENGTH = 4
/** The fewest a lookup takes: three are 29,791, enough to find one Thread among the few a person has in mind. */
export const HANDLE_PREFIX_MIN = 3
/** A Thread's whole code: 31^12 is 7.9e17, so two of 100,000 Threads share one six times in a billion. */
export const HANDLE_CODE_LENGTH = 12
/** The most of its folder's name a handle's word keeps. */
const WORD_MAX = 12
/** The word of a Thread with no project, a chat. */
const CHAT_WORD = "chat"
/** The word of a project whose folder's name has no Latin letter or digit to make one from. */
const UNNAMED_WORD = "thread"

const BASE = BigInt(HANDLE_ALPHABET.length)
const CODE = new RegExp(`^[${HANDLE_ALPHABET}]{${HANDLE_PREFIX_MIN},${HANDLE_CODE_LENGTH}}$`)
/** A handle as typed: its code, after a word of letters, digits and hyphens when it has one. */
const TYPED = /^(?:[a-z0-9]+-)*([a-z0-9]+)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A chat's own folder, by its place under `CHATS_FOLDER` in any home. */
const CHAT = new RegExp(`[\\\\/]${CHATS_FOLDER.join("[\\\\/]")}(?:[\\\\/][^\\\\/]+)?$`)

/**
 * A Thread's code: `HANDLE_CODE_LENGTH` characters of `HANDLE_ALPHABET` from the SHA-256 of its ID, read as one
 * number and written in base 31, so each is as likely as any other whatever shape the ID has. A handle is a prefix of it.
 */
export function threadCode(thread: string): string {
  let rest = BigInt(`0x${sha256Hex(thread)}`)
  let code = ""
  for (let at = 0; at < HANDLE_CODE_LENGTH; at++) {
    code += HANDLE_ALPHABET[Number(rest % BASE)]
    rest /= BASE
  }
  return code
}

/**
 * A handle's word, from the Thread's project folder: its name in lower case, accents dropped, each run of anything
 * but a letter or a digit a hyphen, cut to `WORD_MAX`. A Thread with no project, or in a chat's folder, is `chat`.
 * A Thread in a worktree passes its project's folder, not the worktree's.
 */
export function handleWord(project: string | undefined): string {
  const folder = project?.replace(/[\\/]+$/, "")
  if (!folder || CHAT.test(folder)) return CHAT_WORD
  const name = folder.slice(Math.max(folder.lastIndexOf("/"), folder.lastIndexOf("\\")) + 1)
  const word = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-/, "").slice(0, WORD_MAX).replace(/-$/, "")
  return word || UNNAMED_WORD
}

/** A Thread's handle, with `length` characters of its code: more than `HANDLE_LENGTH` where two Threads share those. */
export function threadHandle(thread: string, project: string | undefined, length = HANDLE_LENGTH): string {
  return `${handleWord(project)}-${threadCode(thread).slice(0, length)}`
}

/**
 * The start of a code that `typed` names, or undefined when it isn't a handle: in any case, with or without its word
 * or a leading `@`, at least `HANDLE_PREFIX_MIN` characters. A Thread's ID is never read as one, though its last
 * group can be spelled in the alphabet.
 */
export function handleCode(typed: string): string | undefined {
  const text = typed.trim().toLowerCase().replace(/^@/, "")
  if (UUID.test(text)) return undefined
  const code = TYPED.exec(text)?.[1]
  return code !== undefined && CODE.test(code) ? code : undefined
}
