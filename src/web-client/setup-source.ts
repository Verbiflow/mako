import { z } from "zod"
import { BORROW_PATHS, GrantSchema, LeaseEventSchema, LeaseSchema, SourceAskSchema, type SourceAnswer } from "@mako/protocol/borrow"
import { accountSetupView, type AccountDevice, type Asker, type SetupView } from "@mako/host/contracts/setup"
import type { SetupSource } from "@/state/setup"
import type { Gateway } from "./gateway"

/** How far back the lease log is read for refusals, as the Mac's host reads its own. */
const REFUSALS_SINCE_MS = 7 * 24 * 60 * 60_000

/** The part of the web app's gateway client Setup calls: the account's own routes, answered as JSON. */
export type BorrowGateway = Pick<Gateway, "rest">

/**
 * A project's Setup from a browser away from the Mac: built here, from the account broker's own lists, by the same
 * `setupView` a Mac's host uses. Decline answers a source's ask, Stop revokes a grant; a yes, a copy or an addition
 * is the source's own Mac's to make, and says so.
 */
export function webSetup(
  gateway: BorrowGateway,
  account: string,
  devices: () => readonly AccountDevice[],
  now: () => number = Date.now,
  askers?: (thread: string) => Omit<Asker, "thread"> | undefined
): SetupSource {
  const pages = new Map<string, SetupView>()
  return {
    read: async (project) => {
      const at = now()
      const [grants, leases, events, asks] = await Promise.all([
        gateway.rest("GET", BORROW_PATHS.grants).then((answer) => z.object({ grants: z.array(GrantSchema) }).parse(answer).grants),
        gateway.rest("GET", "/v1/borrow/leases").then((answer) => z.object({ leases: z.array(LeaseSchema) }).parse(answer).leases),
        gateway.rest("GET", `${BORROW_PATHS.events}?since=${at - REFUSALS_SINCE_MS}`).then((answer) => z.object({ events: z.array(LeaseEventSchema) }).parse(answer).events),
        gateway.rest("GET", "/v1/borrow/asks").then((answer) => z.object({ asks: z.array(SourceAskSchema) }).parse(answer).asks),
      ])
      const page = accountSetupView({ now: at, project, devices: devices(), snapshot: { grants, leases, events, asks: asks.map((ask) => ({ ask, at })) }, ...(askers && { askers }) })
      pages.set(project, page)
      return page
    },
    act: async (project, act) => {
      const page = pages.get(project)
      if (act.act === "answer") {
        if (act.answer !== "decline") return { done: false, why: "Allow it on the Mac that holds it: only its source can say yes." }
        const no: SourceAnswer = { answer: "no", by: { kind: "person", account } }
        await gateway.rest("POST", `/v1/borrow/asks/${encodeURIComponent(act.ask)}`, no)
        return { done: true }
      }
      if (act.act === "row" && act.action === "stop") {
        const row = page?.places.find((place) => place.id === act.place)?.parts.flatMap((part) => part.rows).find((entry) => entry.id === act.row)
        if (!row || row.origin.from === "reading" || row.origin.from === "ask") return { done: false, why: "That row isn't on the page anymore." }
        await gateway.rest("DELETE", `${BORROW_PATHS.grants}/${encodeURIComponent(row.origin.grant)}`)
        return { done: true }
      }
      return { done: false, why: "Do this from your Mac, where it's kept." }
    },
  }
}

/** A Thread as the account's list names it, for an ask it made: its title and harness. */
export function listedAsker(rows: readonly { thread: string; title?: string; harness: string }[], thread: string): Omit<Asker, "thread"> | undefined {
  const row = rows.find((each) => each.thread === thread && each.title)
  return row?.title ? { title: row.title, harness: row.harness, fin: false } : undefined
}
