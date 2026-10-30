import { useEffect, useMemo, useState } from "react"
import { useAccountList, type AccountListState } from "./account-list"
import { useWebClient, type WebClient } from "./client"
import { diagnose, type Diagnosis, type HopState, type ReachInput } from "./diagnosis"
import { CLOUD, useReach, type Reached } from "./reach"
import { useForm, type WebForm } from "./route"

/** "Checking…" stays this long at least, so a quick answer reads as a check and not a flicker. */
export const CHECKING_MS = 600

/** Whether the browser says it has a network, as it changes. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine)
    window.addEventListener("online", changed)
    window.addEventListener("offline", changed)
    return () => {
      window.removeEventListener("online", changed)
      window.removeEventListener("offline", changed)
    }
  }, [])
  return online
}

/** Mako Cloud as this browser last heard it: its last answer, else the list's own standing. */
export function cloudState(list: Pick<AccountListState, "phase" | "failure">, reached: Reached | undefined): HopState {
  if (reached) return reached.ok ? "ok" : "failed"
  if (list.phase === "live") return "ok"
  if (list.phase === "reconnecting" && list.failure) return "failed"
  return "unknown"
}

/** What a diagnosis quotes besides its hops: this browser, its build, the list's number. */
export function baseFacts(client: WebClient, list: Pick<AccountListState, "seq" | "phase">, now: number): Array<[string, string]> {
  const facts: Array<[string, string]> = [["This browser", client.deviceId], ["List", `${list.phase}${list.seq === undefined ? "" : ` at ${list.seq}`}`]]
  if (client.options.build) facts.push(["Build", client.options.build])
  facts.push(["Checked", new Date(now).toISOString()])
  return facts
}

/** The account's list's reach: this phone and Mako Cloud. Undefined while the list is followed. */
export function useListDiagnosis(): Diagnosis | undefined {
  const client = useWebClient()
  const online = useOnline()
  const list = useAccountList((state) => state)
  const cloud = useReach((state) => state.places.get(CLOUD))
  const now = useNow()
  const here = hereOf(useForm())
  return useMemo(() => {
    const input: ReachInput = { now, here, online, cloud: list.phase === "live" ? "ok" : cloudState(list, cloud), facts: baseFacts(client, list, now) }
    const failure = list.failure ?? (cloud && !cloud.ok ? { message: cloud.message ?? "No answer", at: cloud.at, ...(cloud.correlationId && { correlationId: cloud.correlationId }) } : undefined)
    if (failure) input.failure = failure
    return diagnose(input)
  }, [client, online, list, cloud, now, here])
}

/**
 * Asks Mako Cloud again, now: the account's list read afresh (a read the network failed is asked once more on its
 * own), and every socket checked.
 */
export async function checkList(client: WebClient): Promise<void> {
  client.gateway.wake()
  client.list.wake()
  await client.list.refresh().catch(() => undefined)
}

/** Try again: "Checking…" while `check` runs, a beat at least, then whatever the hops say now. */
export function useTryAgain(check: () => Promise<void>) {
  const [checking, setChecking] = useState(false)
  const tryAgain = () => {
    if (checking) return
    setChecking(true)
    const started = Date.now()
    void check()
      .catch(() => undefined)
      .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, CHECKING_MS - (Date.now() - started)))))
      .finally(() => setChecking(false))
  }
  return { checking, tryAgain }
}


/** The time, read again every half minute: what a diagnosis says of "last seen" moves on while it shows. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** What this end of a diagnosis is called, by the form the browser takes. */
export function hereOf(form: WebForm): string {
  return form === "phone" ? "This phone" : form === "tablet" ? "This tablet" : "This browser"
}
