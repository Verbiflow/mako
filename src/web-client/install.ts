import { useSyncExternalStore } from "react"
import { z } from "zod"

/** Chrome's own install prompt, held from the moment the browser offers it until the person asks. */
interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: InstallPrompt
  }
}

let held: InstallPrompt | undefined
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}

/**
 * Listens for the browser's install prompt from the start: Chrome offers it once, early, often before the app has drawn
 * anything, and an app that wasn't listening then can't ask later in the visit.
 */
export function holdInstallPrompt(): void {
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault()
    held = event
    changed()
  })
  addEventListener("appinstalled", () => {
    held = undefined
    changed()
  })
}

/** Opened from the Home Screen (or installed elsewhere): nothing to offer. */
export function installed(): boolean {
  return matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true)
}

/** An iPhone or iPad, where no browser offers to install and the Share menu's "Add to Home Screen" is the way. */
export function onIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
}

/** How this browser installs the app: Chrome's prompt, the iPhone's Share menu, or not at all. */
export type InstallWay = "prompt" | "ios" | "none"

export function useInstallWay(): InstallWay {
  const prompt = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => held !== undefined
  )
  if (installed()) return "none"
  if (prompt) return "prompt"
  return onIos() ? "ios" : "none"
}

const KEY = "mako:web:install"
const DAY_MS = 86_400_000
export const SNOOZE_MS = 30 * DAY_MS
/** What this browser remembers about offering the install: the days it was used, an approval answered, a "Not now". */
const OfferSchema = z.object({ days: z.array(z.string()).default([]), answered: z.boolean().default(false), snoozedUntil: z.number().default(0) })
type Offer = z.infer<typeof OfferSchema>

export function readOffer(): Offer {
  try {
    return OfferSchema.parse(JSON.parse(localStorage.getItem(KEY) ?? "{}"))
  } catch {
    return OfferSchema.parse({})
  }
}

export function writeOffer(offer: Offer): void {
  localStorage.setItem(KEY, JSON.stringify(offer))
}

/** Today counted as a day the app was used here; two such days, and the app has earned its place on the Home Screen. */
export function noteVisit(now = new Date()): void {
  const offer = readOffer()
  const day = now.toISOString().slice(0, 10)
  if (!offer.days.includes(day)) writeOffer({ ...offer, days: [...offer.days, day].slice(-7) })
}

/** An approval answered from the phone: the moment it's plain why the app belongs on the Home Screen. */
export function noteAnswered(): void {
  const offer = readOffer()
  if (!offer.answered) writeOffer({ ...offer, answered: true })
}

/** Whether to offer the install now: not on a first visit, and not for 30 days after "Not now". */
export function shouldOffer(offer: Offer = readOffer(), now = Date.now()): boolean {
  return now >= offer.snoozedUntil && (offer.days.length >= 2 || offer.answered)
}

/** Chrome's install prompt, asked for once; the browser says whether it was added. */
export async function install(): Promise<boolean> {
  const prompt = held
  if (!prompt) return false
  held = undefined
  changed()
  await prompt.prompt()
  return (await prompt.userChoice).outcome === "accepted"
}

