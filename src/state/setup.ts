import { toast } from "sonner"
import { ZodError } from "zod"
import {
  askAnswerLabel,
  askAnswers,
  askLine,
  SETUP_AWAY_ALLOW,
  viewAsks,
  type AskAnswer,
  type RowAction,
  type SetupAct,
  type SetupActOutcome,
  type SetupAsk,
  type SetupListPart,
  type SetupPlaceView,
  type SetupRow,
  type SetupView,
} from "@mako/host/contracts/setup"
import type { AskCard } from "@/lib/ask-card"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Each project's Setup, by the folder it was read for (`mako:setup`): what each place has for the project and where
 * each thing stands, and the asks waiting on the person. The host keeps the truth; this mirrors its last answer and
 * the place the person picked, so Settings, a Thread's side panel and the Inbox read the same page.
 */
interface SetupState {
  byFolder: Record<string, SetupView>
  failed: Record<string, string>
  /** The place picked per folder; the first place until one is. */
  place: Record<string, string>
  /** A tap asked and not answered yet, by the row's or the ask's ID. */
  busy: Record<string, true>
}

export const setupStore = createStore<SetupState>({ byFolder: {}, failed: {}, place: {}, busy: {} })
export const useSetup = createHook(setupStore)

/** Where the page is read from: this device's host, or (in a browser away from the Mac) the account's broker. */
export interface SetupSource {
  read(folder: string): Promise<SetupView>
  act(folder: string, act: SetupAct): Promise<SetupActOutcome>
}

const bridgeSource: SetupSource = {
  read: (folder) => getMako().setup(folder),
  act: (folder, request) => getMako().setupAct(folder, request),
}
let source: SetupSource | undefined
/** Folders a page asked for before any source could answer: read as soon as one is installed. */
const wanted = new Set<string>()

/**
 * The web app away from a Mac reads Setup through its own source. A page's first read can come before its screen
 * installs the source (a child's effect runs before its parent's), so what was asked is read now.
 */
export function setSetupSource(next: SetupSource | undefined) {
  source = next
  if (!next) return
  const asked = [...wanted]
  wanted.clear()
  for (const folder of asked) void readSetup(folder)
}

function currentSource(): SetupSource | undefined {
  return source ?? (hasBridge() ? bridgeSource : undefined)
}

export async function readSetup(folder: string): Promise<SetupView | undefined> {
  const from = currentSource()
  if (!from) {
    wanted.add(folder)
    return undefined
  }
  try {
    const view = await from.read(folder)
    setupStore.set((state) => {
      const failed = { ...state.failed }
      delete failed[folder]
      return { byFolder: { ...state.byFolder, [folder]: view }, failed }
    })
    return view
  } catch (error) {
    setupStore.set((state) => ({ failed: { ...state.failed, [folder]: readFailure(error instanceof Error ? error : new Error(String(error))) } }))
    return undefined
  }
}

/**
 * Why a read failed, in words the person can act on. A reply this build's schemas refuse (a newer cloud's field, say)
 * is said as that, and its detail goes to the console, never onto the page.
 */
export function readFailure(error: Error): string {
  if (error instanceof ZodError) {
    console.warn("Setup's reply didn't match this build's schema", error.issues)
    return "Its answer wasn't one this version of Mako reads."
  }
  return error.message
}

/** Reads a folder's Setup unless it was read within the last minute: what a Thread's notice asks as it opens. */
export function readSetupIfOld(folder: string, maxAgeMs = 60_000): void {
  const held = setupStore.get().byFolder[folder]
  if (!held || Date.now() - held.at > maxAgeMs) void readSetup(folder)
}

/** Whether a folder's page was built away from its Mac (`SetupView.away`), so only a no or a Stop can be drawn. */
export function useAway(folder: string): boolean {
  return useSetup((state) => Boolean(state.byFolder[folder]?.away))
}

export function choosePlace(folder: string, place: string) {
  setupStore.set((state) => ({ place: { ...state.place, [folder]: place } }))
}

/** The place shown for a folder: the one picked, else the first. */
export function shownPlace(view: SetupView | undefined, picked: string | undefined): SetupPlaceView | undefined {
  return view?.places.find((place) => place.id === picked) ?? view?.places[0]
}

/**
 * The place a Thread runs in, by where its folder is: elsewhere on a cloud machine is the cloud, elsewhere on another
 * device that device, and otherwise this one.
 */
export function threadPlaceId(view: SetupView | undefined, elsewhere: string | undefined): string | undefined {
  if (!view) return undefined
  if (elsewhere && /cloud/i.test(elsewhere)) return view.places.find((place) => place.place.kind === "cloud")?.id
  if (elsewhere) {
    const device = view.places.find((place) => place.place.kind === "device" && elsewhere.includes(place.place.name))
    if (device) return device.id
  }
  return view.places.find((place) => place.place.kind === "device" && place.place.here)?.id ?? view.places[0]?.id
}

/**
 * Every ask, once, oldest first: what the Inbox lists. A project's asks are in the view of each of its folders (its
 * main checkout's, a worktree's), and one ask is one thing to answer.
 */
export function allAsks(state: SetupState): Array<{ folder: string; ask: SetupAsk }> {
  const seen = new Map<string, { folder: string; ask: SetupAsk }>()
  for (const [folder, view] of Object.entries(state.byFolder)) for (const ask of viewAsks(view)) if (!seen.has(ask.id)) seen.set(ask.id, { folder, ask })
  return [...seen.values()].sort((left, right) => left.ask.at - right.ask.at)
}

/** The folders whose views hold an ask: each reads again once it's answered. */
function foldersHolding(state: SetupState, ask: string): string[] {
  return Object.entries(state.byFolder).filter(([, view]) => viewAsks(view).some((held) => held.id === ask)).map(([folder]) => folder)
}

async function act(folder: string, key: string, request: SetupAct): Promise<SetupActOutcome> {
  const holding = request.act === "answer" ? foldersHolding(setupStore.get(), request.ask) : []
  setupStore.set((state) => ({ busy: { ...state.busy, [key]: true } }))
  try {
    const from = currentSource()
    if (!from) return { done: false, why: "Setup can't be changed from here." }
    const outcome = await from.act(folder, request)
    if (!outcome.done) toast(outcome.why)
    return outcome
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    toast(why)
    return { done: false, why }
  } finally {
    setupStore.set((state) => {
      const busy = { ...state.busy }
      delete busy[key]
      return { busy }
    })
    for (const each of new Set([folder, ...holding])) void readSetup(each)
  }
}

/**
 * A new Thread in the project with the request written, which the person reads and sends: how the recipe changes
 * (a tool into its prepare, a file into its carry), since each change is proved before every Thread gets it.
 */
let drafter: ((root: string, text: string) => Promise<boolean>) | undefined

/** How this window starts a Thread with a request written: the desk's own; a browser away from the Mac has none. */
export function setSetupDrafter(next: typeof drafter) {
  drafter = next
}

/**
 * The desk's drafter: a new Thread of the project, then the request written into its composer. It has drafted only
 * when both happened: a Thread that couldn't open, or words no composer took, answer false.
 */
export function setupDrafter(open: (root: string) => Promise<boolean>, compose: (text: string) => Promise<boolean>) {
  return async (root: string, text: string): Promise<boolean> => {
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    if (!(await open(root))) return false
    return compose(text)
  }
}

async function draftInNewThread(root: string, text: string): Promise<boolean> {
  if (!drafter) {
    toast("Ask for this from a Thread on your Mac")
    return false
  }
  const drafted = await drafter(root, text)
  if (!drafted) toast("The request couldn't be written in a new Thread. Try again.")
  return drafted
}

/**
 * The person's answer to an agent's ask: true once it landed, false when it didn't (said in a toast). A tool added to
 * setup is a recipe change, drafted for them to send.
 */
export async function answerAsk(folder: string, ask: SetupAsk, answer: AskAnswer): Promise<boolean> {
  const root = setupStore.get().byFolder[folder]?.root ?? folder
  if (answer === "add-to-setup" && ask.kind === "tool") return draftInNewThread(root, toolRequest(ask.tool, ask.version, ask.by.title))
  return (await act(folder, `ask:${ask.id}`, { act: "answer", ask: ask.id, answer })).done
}

export function toolRequest(tool: string, version: string | undefined, by?: string): string {
  const named = version ? `${tool} ${version}` : tool
  return `Add ${named} to this project's recipe prepare, so every Thread has it without installing it again${by ? ` (${by} needed it)` : ""}. Prove the recipe and publish it.`
}

/** A row's button. Keep on a tool an agent added for its own Thread drafts the recipe change; the rest go to the host. */
export function rowTap(folder: string, place: string, row: SetupRow, action: RowAction) {
  const root = setupStore.get().byFolder[folder]?.root ?? folder
  if (action === "keep" || (action === "add" && row.part === "tools")) {
    void draftInNewThread(root, toolRequest(row.name, undefined))
    return
  }
  void act(folder, row.id, { act: "row", place, row: row.id, action })
}

export function rebuildBase(folder: string) {
  void act(folder, "rebuild", { act: "rebuild" })
}

const ADD_REQUESTS = {
  files: (place: string) => `Add a file or folder this project's Threads need from this Mac to its recipe's carry, for ${place}. Ask me which one first.`,
  access: (place: string) => `Set up access to a service for this project's Threads on ${place}: ask me which one, and never print or read back its value.`,
  tools: (place: string) => `Add a tool to this project's recipe prepare, so Threads on ${place} have it. Ask me which one first.`,
  code: () => "Let this project's Threads read another of the owner's repositories. Ask me which one first.",
  services: (place: string) => `Make a service on my network reachable to this project's Threads on ${place}. Ask me which one first.`,
} satisfies Record<SetupListPart, (place: string) => string>

/** The Add menu's row, or a part's +: a request drafted in a new Thread of the project, for the person to send. */
export function addTo(folder: string, part: SetupListPart, place: SetupPlaceView) {
  const root = setupStore.get().byFolder[folder]?.root ?? folder
  void draftInNewThread(root, ADD_REQUESTS[part](place.place.kind === "cloud" ? "cloud machines" : place.title))
}

/**
 * A Setup ask in the shape every surface draws an ask (`AskCard`): who asks and what for, why, and its answers, the
 * narrowest first. Away from its Mac only no can be said here, and the card says where the rest can.
 */
export function setupAskCard(folder: string, ask: SetupAsk, away: boolean): AskCard {
  const line = askLine(ask)
  const offered = askAnswers(ask)
  return {
    who: ask.by.title,
    want: `${line.verb} ${line.thing}`,
    ...(line.after && { description: line.after }),
    detail: `“${ask.why}”. Answering here is the same as in this Thread's Setup and your Inbox; nothing is added until you do.`,
    ...(away && offered.length > 1 && { note: SETUP_AWAY_ALLOW }),
    choices: askAnswers(ask, away).map((answer, index) => ({ answer, label: askAnswerLabel(ask, answer, true), primary: index === 0 && !away, choose: () => answerAsk(folder, ask, answer) })),
  }
}

/** An ask as one plain line, for a notice or an Inbox row. */
export function setupAskWords(ask: SetupAsk): string {
  const line = askLine(ask)
  return `${line.verb} ${line.thing}${line.after ? `, ${line.after}` : ""}`
}

