import { z } from "zod"
import type { Gateway } from "./gateway"

/** Hours a browser's notices wait for, in its own time zone: `22:00` to `07:00`. */
export interface QuietHours {
  start: string
  end: string
}

/**
 * Where this browser's notifications stand. `install`: Safari on an iPhone or iPad delivers them only to the app added
 * to the Home Screen; `unsupported`: this browser has no Web Push; `denied`: the person said no in the browser.
 */
export type PushStanding = "unsupported" | "install" | "denied" | "off" | "on"

/** What the account keeps for this browser's subscription. */
interface PushSubscriptionView {
  quietHours: QuietHours | null
  timeZone: string
}

const QuietHoursSchema = z.object({ start: z.string(), end: z.string() }) satisfies z.ZodType<QuietHours>
const PushSubscriptionViewSchema = z.object({ quietHours: QuietHoursSchema.nullable(), timeZone: z.string() }) satisfies z.ZodType<PushSubscriptionView>
/** `GET /v1/push`, as read for what the account keeps of this browser's subscription: none, until one is given. */
const PushKeptSchema = z.object({ subscription: PushSubscriptionViewSchema.nullable() })
/** `GET /v1/push`, as read for the key a browser subscribes with: none from a gateway that sends no notices. */
const PushKeySchema = z.object({ key: z.string().nullable() })

/** True on an iPhone or iPad, whose Safari gives Web Push only to an app on the Home Screen. */
function onIos(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1)
}

function standalone(): boolean {
  // Safari's own flag for a page opened from the Home Screen, which no other browser has.
  return matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true)
}

function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * This browser's Web Push: its subscription with the browser's push service, kept by the account, which sends a
 * notice when a Thread needs the person and they aren't at another device. The service worker shows it.
 */
export class WebPush {
  readonly #gateway: Gateway

  constructor(gateway: Gateway) {
    this.#gateway = gateway
  }

  async standing(): Promise<{ standing: PushStanding; quietHours: QuietHours | null }> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      return { standing: onIos() && !standalone() ? "install" : "unsupported", quietHours: null }
    if (Notification.permission === "denied") return { standing: "denied", quietHours: null }
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    if (!subscription) return { standing: "off", quietHours: null }
    const kept = PushKeptSchema.parse(await this.#gateway.rest("GET", "/v1/push"))
    return kept.subscription ? { standing: "on", quietHours: kept.subscription.quietHours } : { standing: "off", quietHours: null }
  }

  /** Asks the browser, subscribes with the account's key, and gives the account the subscription. */
  async enable(quietHours: QuietHours | null): Promise<PushStanding> {
    const permission = await Notification.requestPermission()
    if (permission !== "granted") return permission === "denied" ? "denied" : "off"
    const registration = await navigator.serviceWorker.ready
    const { key } = PushKeySchema.parse(await this.#gateway.rest("GET", "/v1/push"))
    if (key === null) throw new Error("This Mako server doesn't send notifications yet.")
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(key) }))
    await this.save(subscription, quietHours)
    return "on"
  }

  /** The quiet hours changed, or the subscription is given again (as each start does, in case the account lost it). */
  async save(subscription: PushSubscription, quietHours: QuietHours | null): Promise<void> {
    await this.#gateway.rest("PUT", "/v1/push/subscription", {
      subscription: subscription.toJSON(),
      quietHours,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  async setQuietHours(quietHours: QuietHours | null): Promise<void> {
    const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
    if (subscription) await this.save(subscription, quietHours)
  }

  async disable(): Promise<void> {
    const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
    await this.#gateway.rest("DELETE", "/v1/push/subscription")
    await subscription?.unsubscribe()
  }

  /** At each start: a subscription this browser holds is given to the account again, so the two never disagree. */
  async renew(): Promise<void> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return
    const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
    if (!subscription) return
    const kept = PushKeptSchema.parse(await this.#gateway.rest("GET", "/v1/push"))
    await this.save(subscription, kept.subscription?.quietHours ?? null)
  }
}
