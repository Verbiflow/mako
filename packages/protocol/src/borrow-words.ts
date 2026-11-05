import type { BorrowAnswer } from "./borrow.js"

/**
 * Borrowing's operations and waits in the person's words, the same on every surface that says them: Settings › Fins on
 * the device that lends one, Setup's Needs you, and the agent's own tool answers.
 */
const OPERATIONS = {
  "ios-simulator": "an iOS simulator",
  "android-emulator": "an Android emulator",
  xcode: "Xcode",
  gpu: "a GPU",
  macos: "a Mac",
  cli: "a command-line tool",
} as const satisfies Record<string, string>

/** What an operation or a capability is, as a person says it: "an iOS simulator". */
export function operationWords(ref: string): string {
  return isKnown(ref) ? OPERATIONS[ref] : ref
}

function isKnown(ref: string): ref is keyof typeof OPERATIONS {
  return Object.hasOwn(OPERATIONS, ref)
}

/** A device a wait's words may name: what the person calls it, and when the broker last heard it. */
export type WordedDevice = { id: string; name: string; online: boolean; lastSeen: number | null }

/** "an iOS simulator" as a line's head: "iOS simulator". */
function head(ref: string): string {
  const words = operationWords(ref).replace(/^(an?|the) /, "")
  // A name that keeps its own case (iOS) stays as it is.
  return /^[a-z][A-Z]/.test(words) ? words : words.charAt(0).toUpperCase() + words.slice(1)
}

function ordinal(position: number): string {
  const tens = position % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][position % 10] ?? "th")
  return `${position}${suffix}`
}

/** "30 min", "2 h", "a day": how long, as a wait says it. */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours >= 24 ? (hours < 36 ? "a day" : `${Math.round(hours / 24)} days`) : `${hours} h`
}

/** Who a wait is on: the one capable device by name, or the person's devices. */
function onWhom(devices: readonly WordedDevice[]): string {
  return devices.length === 1 ? devices[0]!.name : "your Macs"
}

/**
 * A borrowing answer as the agent and the person read it, with its reason and its deadline:
 * "iOS simulator: on Kashyab's Mac, queued (2nd), starts when it's free." A device that's asleep reads "offline,
 * waiting": waking it is the person's to allow, never the wait's.
 */
export function borrowWords(answer: BorrowAnswer, ref: string, devices: readonly WordedDevice[], now: number): string {
  const what = head(ref)
  if ("lease" in answer) {
    const on = devices.find((device) => device.id === answer.lease.device)
    return `${what}: on ${on?.name ?? "your Mac"}, yours now.`
  }
  if ("pending" in answer) {
    if (answer.pending === "source") {
      const source = answer.source
      const asked = source.kind === "device" ? devices.find((device) => device.id === source.device) : undefined
      return `${what}: asking ${asked?.name ?? "your Mac"}; it starts once it says yes.`
    }
    const left = `waiting up to ${spanWords(Math.max(0, answer.deadline - now))}`
    if (answer.why === "all-busy") return `${what}: on ${onWhom(devices)}, queued (${ordinal(answer.position)}), starts when it's free; ${left}.`
    if (answer.why === "no-device-online") {
      const seen = devices.map((device) => device.lastSeen).filter((at): at is number => at !== null)
      const last = seen.length ? ` ${onWhom(devices)} ${devices.length === 1 ? "was" : "were"} last seen ${spanWords(now - Math.max(...seen))} ago.` : ""
      return `${what}: ${onWhom(devices)} ${devices.length === 1 ? "is" : "are"} offline, waiting; ${left}.${last} Waking ${devices.length === 1 ? "it" : "one"} is yours to do.`
    }
    return `${what}: no Mac of yours has ${operationWords(ref)} ready; ${left}. Settings › Simulators on a Mac sets one up.`
  }
  const { refusal } = answer
  switch (refusal.refused) {
    case "no-capable-device":
      return `${what}: no Mac could lend ${operationWords(ref)} within ${spanWords(refusal.waited)} (${refusal.why === "all-busy" ? "each was busy" : refusal.why === "no-device-online" ? "none was online" : "none has one ready"}). Ask again to wait once more.`
    case "declined":
      return `${what}: the person declined it on their Mac. Don't ask again unless they say so.`
    case "no-grant":
      return `${what}: nothing lets this Thread borrow ${operationWords(ref)} yet. The person can allow it in Setup.`
    case "revoked":
      return `${what}: the person took back this Thread's use of it.`
    case "expired":
      return `${what}: the grant for it has lapsed.`
    case "out-of-scope":
      return `${what}: the person's grant doesn't reach this Thread's project.`
    case "thread-ended":
      return `${what}: this Thread has ended.`
    case "source-offline":
      return `${what}: ${onWhom(devices)} is offline.`
    case "too-large":
      return `${what}: too large to lend.`
    case "unavailable":
      return `${what}: the Mac couldn't lend it (${refusal.reason}).`
  }
}
