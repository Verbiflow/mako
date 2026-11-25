import { localWords } from "@mako/protocol/computer-words"

/**
 * A move's words, one source for every client: the desktop's notice over the composer (`thread-move-notice.tsx`) and
 * the web app's strip (`web-client/move-card.tsx`) say a step, a title and an action the same way. Only where the
 * Thread is from changes: the computer that holds it says itself (`localWords`) and "here", any other device names it.
 */
export type MoveVantage = { kind: "here" } | { kind: "away"; mac: string }

const HERE: MoveVantage = { kind: "here" }
export const moveHere = (): MoveVantage => HERE
export const moveAway = (mac: string): MoveVantage => ({ kind: "away", mac })

/** The computer that holds the Thread, said from it, or by its name from anywhere else. */
export function macWords(vantage: MoveVantage): string {
  return vantage.kind === "here" ? localWords("this Mac") : vantage.mac
}

/** A step of a move to the cloud. */
export function cloudStepWords(step: string, handOff: boolean): string {
  switch (step) {
    case "own-branch":
      return "Onto its own branch"
    case "packing":
      return handOff ? "Sending ahead" : "Sending its work ahead"
    case "pausing":
      return "Pausing the turn"
    case "handing-over":
    case "moving":
      return "Handing over"
    case "resuming":
      return handOff ? "Continuing in the cloud" : "Resuming in the cloud"
    default:
      return "Moving"
  }
}

/** A step of the way back from the cloud. */
export function returnStepWords(step: string, vantage: MoveVantage): string {
  switch (step) {
    case "packing":
      return "Packing in the cloud"
    case "bringing":
    case "moving":
      return vantage.kind === "here" ? "Bringing it here" : `Bringing it to ${vantage.mac}`
    default:
      return "Coming back"
  }
}

/** A move's title while it goes, and once its answer is lost on the way. */
export const MOVE_WORDS = {
  moving: "Moving to the cloud",
  handingOff: "Handing off to the cloud",
  unconfirmed: "Move not confirmed",
  checkStatus: "Check status",
  checking: "Checking status…",
  retry: "Retry move",
  cloudAnswer: "Waiting for the cloud's answer",
} as const

/** A move that didn't happen: where the Thread still is. */
export function stillOnWords(vantage: MoveVantage): string {
  return `Still on ${macWords(vantage)}`
}

/** The way back while it goes. */
export function comingBackWords(vantage: MoveVantage): string {
  return `Coming back to ${macWords(vantage)}`
}
