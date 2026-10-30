import type { Json } from "@mako/protocol"
import { bootFolder, type CloudRepository } from "@mako/host/contracts/cloud-threads"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { harnessOrder as savedOrder } from "@mako/host/contracts/harness-defaults"
import type { LiveSnapshot, LiveStartOptions } from "@mako/host/contracts/live-conversations"
import type { HarnessProfile, PromptAttachment } from "@mako/host/contracts/providers-acp"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import type { ThreadWorktrees } from "@mako/host/contracts/thread-worktrees"
import type { SessionModel } from "@mako/sessions/settings"
import { z } from "zod"
import { errorMessage } from "@mako/host/contracts/error-message"
import { whileBusy } from "./busy"
import { CONSOLE_LOG, type Gateway } from "./gateway"
import { WEB_HARNESSES } from "./labels"
import { answered, macPlace, reachLog, threadPlace } from "./reach"

/**
 * One host call to one of the account's Macs, through its runtime link: the same call its own window makes, answered
 * by its host as it answers that window (`serveHostThroughGateway`). Said at once, as itself, when the Mac is off.
 */
export async function macCall<Result>(gateway: Gateway, webDeviceId: string, deviceId: string, channel: string, args: readonly unknown[], how: { history?: boolean } = {}): Promise<Result> {
  const runtimeId = `d-${deviceId}`
  const place = macPlace(deviceId)
  const log = reachLog(place)
  const send = gatewayHostCalls(gateway.session, { runtimeId, actor: { kind: "client", client: "web", deviceId: webDeviceId }, history: how.history ?? false, log }).call(channel, args)
  const value = await sendWithRepeats(channel, send, { runtime: runtimeId, log })
  answered(place)
  // SAFETY: the Mac's host answers each channel with the value its bridge method declares, as to its own window.
  return decodeRuntimeValue(value) as Result
}

/** One harness as a place offers it: signed in or not, its models and the one it starts on. */
export interface OfferedHarness {
  harness: string
  available: boolean
  /** Still being asked there: listed, not yet known. */
  pending: boolean
  models: readonly SessionModel[]
  /** The model it starts on when none is chosen: the person's configured one there, else the harness's own. */
  defaultModel?: string
  error?: string
}

/** What a place offers a new Thread: its harnesses, in the person's order there. */
export interface Catalog {
  harnesses: OfferedHarness[]
  /** The person's harness order as that Mac keeps it, Mako's own when they never changed it. */
  order: string[]
}

function offered(profile: HarnessProfile): OfferedHarness {
  const harness: OfferedHarness = { harness: profile.id, available: profile.available, pending: profile.pending === true, models: profile.models.filter((model) => !model.unavailable) }
  const model = profile.configuredModel ?? profile.defaultModel
  if (model) harness.defaultModel = model
  if (profile.error) harness.error = profile.error
  return harness
}

/**
 * A Mac's harnesses as its own composer lists them, each as the Mac knows it (`mako:harness-tuning` in the folder, the
 * call its composer makes for the harness it shows), told one by one as each is known: a harness still being asked is
 * listed as pending, and the slowest never holds the rest. With the person's harness order the Mac keeps.
 */
export function macCatalog(gateway: Gateway, webDeviceId: string, deviceId: string, folder: string | undefined, told: (catalog: Catalog) => void): Promise<void> {
  const harnesses = new Map<string, OfferedHarness>(WEB_HARNESSES.map((harness) => [harness, { harness, available: false, pending: true, models: [] }]))
  let order: string[] = [...WEB_HARNESSES]
  const tell = () => told({ harnesses: [...harnesses.values()], order })
  tell()
  const asked = [
    macCall<string[]>(gateway, webDeviceId, deviceId, "mako:harness-order-saved", []).then((saved) => {
      order = savedOrder(saved, WEB_HARNESSES)
      tell()
    }, () => undefined),
    ...WEB_HARNESSES.map((harness) =>
      macCall<HarnessProfile>(gateway, webDeviceId, deviceId, "mako:harness-tuning", [harness, folder, false]).then(
        (profile) => {
          harnesses.set(harness, offered(profile))
          tell()
        },
        (error) => {
          harnesses.set(harness, { harness, available: false, pending: false, models: [], error: errorMessage({ error }) })
          tell()
        }
      )
    ),
  ]
  return Promise.all(asked).then(() => undefined)
}

/**
 * The cloud's harnesses: the ones its machines run, each with its models as the person's own Mac lists them (the cloud
 * signs in with that Mac's sign-ins, so it offers the same models); without a Mac to ask, each starts on its default.
 */
export function cloudCatalog(harnesses: readonly string[], mac: Catalog | undefined): Catalog {
  const known = new Map(mac?.harnesses.map((each) => [each.harness, each]))
  return {
    harnesses: harnesses.map((harness) => {
      const listed = known.get(harness)
      return listed ? { ...listed, available: true, pending: false } : { harness, available: true, pending: false, models: [] }
    }),
    order: mac?.order ?? [...WEB_HARNESSES],
  }
}

/** A Mac's worktrees, so its Sessions in them count for their projects. */
export function macWorktrees(gateway: Gateway, webDeviceId: string, deviceId: string): Promise<ThreadWorktrees> {
  return macCall<ThreadWorktrees>(gateway, webDeviceId, deviceId, "mako:worktrees", [])
}

/** A first message, as every start carries it. */
export interface FirstMessage {
  text: string
  attachments: PromptAttachment[]
  title?: string
}

/** What a start runs with besides its message: the model, and the access mode the person chose for the harness. */
export interface Loadout {
  harness: string
  model: string | undefined
  /** `accessInEffect(…).mode`: named, so the start runs in what the sheet showed, wherever it runs. */
  mode: string | undefined
}

function startOptions(conversationId: string, message: FirstMessage, loadout: Loadout, extra: Partial<LiveStartOptions> = {}): LiveStartOptions {
  const options: LiveStartOptions = { conversationId, initialRequest: { id: crypto.randomUUID(), text: message.text, attachments: message.attachments }, ...extra }
  if (message.title) options.title = message.title
  if (loadout.model) options.tuning = { model: loadout.model }
  if (loadout.mode) options.modeId = loadout.mode
  return options
}

/** What a start made: the conversation its first message went to, and its Thread, as the list will name it. */
export interface Started {
  conversationId: string
  /** Mako's Thread ID on a Mac; the cloud Thread's ID for the cloud (the list matches either). */
  threadId: string
}

/**
 * Starts a Thread on a Mac, as its own window does: `mako:live-start` in the folder, with the harness, its model, the
 * person's access mode and the first message. Its host lists it to the account as it starts, so every device sees it.
 */
export async function startOnMac(gateway: Gateway, webDeviceId: string, deviceId: string, start: Loadout & { folder: string; message: FirstMessage }): Promise<Started> {
  const conversationId = crypto.randomUUID()
  const snapshot = await whileBusy(macCall<LiveSnapshot>(gateway, webDeviceId, deviceId, "mako:live-start", [start.harness, start.folder, startOptions(conversationId, start.message, start)], { history: true }))
  return { conversationId, threadId: snapshot.threadId ?? conversationId }
}

/** The steps of a cloud start, as the sheet says them: the Thread made, its machine up and its folder read, the harness started. */
export type CloudStep = "making" | "preparing" | "starting"

/**
 * Starts a Thread in the cloud, as a Mac's cloud start does (`CloudConversations.#start`): the Thread made with its
 * repository, its machine's folder read from its boot, then the harness started there with the first message. A
 * machine that couldn't clone the repository fails its boot with why (`folderUnmade`), so nothing starts.
 */
export function startInCloud(gateway: Gateway, webDeviceId: string, start: Loadout & { repository: CloudRepository; message: FirstMessage }, step: (step: CloudStep) => void): Promise<Started> {
  return whileBusy(cloudStart(gateway, webDeviceId, start, step))
}

async function cloudStart(gateway: Gateway, webDeviceId: string, start: Loadout & { repository: CloudRepository; message: FirstMessage }, step: (step: CloudStep) => void): Promise<Started> {
  step("making")
  const threadId = `t-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
  await gateway.rest("POST", "/v1/threads", { threadId, home: "cloud", repository: start.repository, harness: start.harness })
  const calls = gatewayHostCalls(gateway.session, { threadId, actor: { kind: "client", client: "web", deviceId: webDeviceId }, history: true, log: CONSOLE_LOG })
  step("preparing")
  const cwd = bootFolder(await sendWithRepeats("mako:boot", calls.call("mako:boot", []), { threadId, log: CONSOLE_LOG }))
  step("starting")
  const conversationId = crypto.randomUUID()
  await sendWithRepeats("mako:live-start", calls.call("mako:live-start", [start.harness, cwd, startOptions(conversationId, start.message, start)]), { threadId, conversationId, log: CONSOLE_LOG })
  return { threadId, conversationId }
}

/** Who answers a Thread's calls: one of the account's Macs, or a cloud Thread's machine. */
export type Owner = { kind: "mac"; deviceId: string } | { kind: "cloud"; threadId: string }

/** One host call to a Thread's owner, whichever it is. */
export async function ownerCall<Result>(gateway: Gateway, webDeviceId: string, owner: Owner, channel: string, args: readonly unknown[], how: { history?: boolean } = {}): Promise<Result> {
  if (owner.kind === "mac") return macCall<Result>(gateway, webDeviceId, owner.deviceId, channel, args, how)
  const place = threadPlace(owner.threadId)
  const log = reachLog(place)
  const send = gatewayHostCalls(gateway.session, { threadId: owner.threadId, actor: { kind: "client", client: "web", deviceId: webDeviceId }, history: how.history ?? false, log }).call(channel, args)
  const value = await sendWithRepeats(channel, send, { threadId: owner.threadId, log })
  answered(place)
  // SAFETY: the machine's host answers each channel with the value its bridge method declares.
  return decodeRuntimeValue(value) as Result
}

/**
 * Adds a Session to a Thread, as the desk's `+` tab does: an empty Session made in the Thread on its owner
 * (`mako:thread-create-session`), then the harness started in it in the Thread's folder, in the person's mode for it,
 * with the first message.
 */
export function addSession(gateway: Gateway, webDeviceId: string, owner: Owner, start: Loadout & { thread: string; folder: string; message: FirstMessage }): Promise<Started> {
  return whileBusy(
    (async () => {
      const placement = await ownerCall<{ session: string }>(gateway, webDeviceId, owner, "mako:thread-create-session", [crypto.randomUUID(), start.thread])
      const conversationId = crypto.randomUUID()
      await ownerCall<Json>(gateway, webDeviceId, owner, "mako:live-start", [start.harness, start.folder, startOptions(conversationId, start.message, start, { session: placement.session })], { history: true })
      return { conversationId, threadId: start.thread }
    })()
  )
}

/** What the gateway answers for a preview: the address that opens it, on an origin of its own, and until when. */
const PreviewSchema = z.object({ url: z.string().url(), expiresAt: z.number() })

/**
 * A Thread's app, on the phone: its website, served by the gateway on an origin of its own (an agent's page never runs
 * where the API does) and reached through its owner, a cloud machine or the person's Mac by its own link. The address
 * names an unguessable grant the gateway keeps for this person, Thread and port, so it needs no cookie (an iPhone
 * keeps none for a page inside another), opens in a browser just as well, and ends when it's unused for an hour.
 */
export async function previewAddress(gateway: Gateway, owner: Owner, port: number): Promise<{ url: string; expiresAt: number }> {
  const target = owner.kind === "cloud" ? { threadId: owner.threadId } : { deviceId: owner.deviceId }
  return PreviewSchema.parse(await gateway.rest("POST", "/v1/previews", { ...target, port }))
}

