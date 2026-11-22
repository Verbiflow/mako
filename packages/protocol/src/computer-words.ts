/**
 * Mako's words for the computer its host runs on. They were written on a Mac and say "this Mac", "your Mac", "the
 * Mac"; on Windows and Linux the same sentence says "computer". A sentence is written once, in the Mac's words, and
 * passed through `localWords` where it is said: `localWords("Kept on this Mac.")` is that sentence on a Mac, to the
 * byte, and "Kept on this computer." elsewhere. `scripts/check-computer-words.mjs` holds new sentences to it. Log
 * lines aren't passed through: they keep one wording on every platform, for whoever reads them.
 *
 * Only a Mac that stands for "the computer" is reworded: one named with `this`, `your`, `the`, `its`, `their`,
 * `another`, `other`, `every`, `each` or `no`. "A Mac", "Mac" on its own and "Macs" name the kind of device (a Mac
 * with Xcode, a row in a list of devices) and stay.
 *
 * Which words, in order:
 *  - what the host said its platform is, which a window writes on its page as it boots (`hostSaidPlatform`);
 *  - `MAKO_COMPUTER_WORDS=mac|computer`, for the suites: they assert the Mac's sentences and set `mac` where they run
 *    on Linux and Windows;
 *  - the platform of the process itself, where there is one to ask (the host, and everything it runs);
 *  - the desktop app's own system, which is its host's, as Electron names it in its user agent;
 *  - otherwise (a page in a browser, a phone, before the host has spoken) the Mac's.
 */
export type ComputerWords = "mac" | "computer"

/** Which words a platform takes: a Mac's on macOS, a computer's everywhere else. */
export function computerWordsFor(platform: string): ComputerWords {
  return platform === "darwin" ? "mac" : "computer"
}

const DETERMINERS = ["this", "your", "the", "its", "their", "another", "other", "every", "each", "no"]
const REWORDED = new RegExp(`\\b(${DETERMINERS.join("|")})( own)? Mac\\b`, "gi")

/** `text` in the words for `words`: itself for a Mac, with "this Mac" as "this computer" otherwise. */
export function computerWords(text: string, words: ComputerWords): string {
  if (words === "mac") return text
  return text.replace(REWORDED, (_match, determiner: string, own: string | undefined) => `${determiner}${own ?? ""} computer`)
}

/** What this code can ask about where it runs: a Node process has the first, a page the second. */
interface Surroundings {
  process?: { platform?: string; env?: { MAKO_COMPUTER_WORDS?: string } }
  navigator?: { userAgent?: string }
  document?: { documentElement?: { dataset?: { hostPlatform?: string } } | null }
}

/** The platform the host said it runs on, kept on the window's page (`<html data-host-platform>`) as it boots. */
export function hostSaidPlatform(platform: string, surroundings: Surroundings = globalThis): void {
  const dataset = surroundings.document?.documentElement?.dataset
  if (dataset) dataset.hostPlatform = platform
}

/** The words in force here; see the order above. */
export function localComputerWords(surroundings: Surroundings = globalThis): ComputerWords {
  const said = surroundings.document?.documentElement?.dataset?.hostPlatform
  if (said) return computerWordsFor(said)
  const chosen = surroundings.process?.env?.MAKO_COMPUTER_WORDS
  if (chosen === "mac" || chosen === "computer") return chosen
  const platform = surroundings.process?.platform
  if (platform) return computerWordsFor(platform)
  const agent = surroundings.navigator?.userAgent ?? ""
  if (agent.includes("Electron/") && (agent.includes("Windows NT") || agent.includes("Linux"))) return "computer"
  return "mac"
}

export function localWords(text: string): string {
  return computerWords(text, localComputerWords())
}
