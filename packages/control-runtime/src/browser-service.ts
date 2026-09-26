import { BrowserCapture, type BrowserFrame } from "./browser-capture.js"
import { BrowserFocus } from "./browser-focus.js"
import { BrowserRecordings } from "./browser-recording.js"
import { BrowserPreferences } from "./browser-preference.js"
import {
  asideSelectionGuidance,
  tabInterruption,
} from "./browser-compatibility.js"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdtemp, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { z } from "zod"
import { imageSize } from "image-size"
import sharp from "sharp"
import {
  BrowserConnection,
  type BrowserProtocolEvent,
} from "./browser-connection.js"
import {
  navigatePage,
  pageMetrics,
  screenshotGeometry,
  type ElementBox,
} from "./browser-page.js"
import {
  AccessibilityNodeSchema,
  scopeAccessibilityNodes,
  browserObservation,
  OBSERVATION_BUDGET_BYTES,
} from "./browser-observation.js"
import { localBrowsers, type LocalBrowser } from "./browser-discovery.js"
import {
  BrowserFault,
  browserCommandEffect,
  type BrowserCommand,
  type BrowserControlStatus,
  type BrowserTarget,
  type KeyModifierSchema,
} from "./contracts/browser-control.js"
import type { JsonObject, JsonValue } from "./json.js"

const targetInfo = z.object({
  openerId: z.string().optional(),
  makoOwner: z.string().optional(),
  makoTaskLifetime: z.boolean().optional(),
  targetId: z.string(),
  type: z.string(),
  title: z.string(),
  url: z.string(),
})
const targetsResult = z.object({ targetInfos: z.array(targetInfo) })
const sessionResult = z.object({ sessionId: z.string() })
const pointResult = z.object({
  result: z.object({ value: z.object({ x: z.number(), y: z.number() }) }),
})
const boxResult = z.object({
  result: z.object({
    value: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
})
const editableResult = z.object({
  result: z.object({
    value: z.object({ tag: z.string(), length: z.number() }),
  }),
})
const scrollResult = z.object({
  result: z.object({ value: z.object({ x: z.number(), y: z.number() }) }),
})
const mainFrame = z.object({
  frame: z.object({ parentId: z.string().optional() }),
})
const dialogOpening = z.object({
  type: z.string(),
  message: z.string().default(""),
  defaultPrompt: z.string().optional(),
  url: z.string().optional(),
})
const requestEvent = z.object({ requestId: z.string() })
const extensionDownloadSchema = z.object({
  id: z.number(),
  state: z.enum(["completed", "canceled", "inProgress"]),
  url: z.string(),
  path: z.string().nullable(),
  bytes: z.number(),
  error: z.string().nullable(),
})

const downloadBegin = z.object({
  guid: z.string(),
  url: z.string().optional(),
  suggestedFilename: z.string().optional(),
})
const downloadProgress = z.object({
  guid: z.string(),
  state: z.enum(["inProgress", "completed", "canceled"]),
  receivedBytes: z.number().optional(),
  totalBytes: z.number().optional(),
})
const frameNode = z.object({
  frame: z.object({
    id: z.string(),
    parentId: z.string().optional(),
    url: z.string(),
    name: z.string().optional(),
    securityOrigin: z.string().optional(),
  }),
  childFrames: z.array(z.json()).optional(),
})
const historyResult = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
})
const cookieList = z.object({
  cookies: z.array(
    z.looseObject({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.string().optional(),
    })
  ),
})
const isolatedWorld = z.object({ executionContextId: z.number() })
const pdfResult = z.object({ data: z.string() })
const waitResult = z.object({ result: z.object({ value: z.boolean() }) })
/** One page-side poll never outlives the connection's request timeout. */
const WAIT_SLICE_MS = 20_000
interface DialogState {
  type: string
  message: string
  defaultPrompt?: string
  url?: string
  openedAt: number
}
interface DownloadState {
  guid: string
  url?: string
  suggestedFilename?: string
  state: "inProgress" | "completed" | "canceled"
  receivedBytes?: number
  totalBytes?: number
}
/** Targets that render a document and accept page-level input. */
const PAGE_TARGET_TYPES = new Set(["page", "iframe", "webview"])
const EVENT_ENTRY_LIMIT = 128
const EVENT_ENTRY_BYTES = 16_384
type Modifier = z.infer<typeof KeyModifierSchema>
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} satisfies Record<Modifier, number>
const BUTTON_BITS = { left: 1, right: 2, middle: 4 } as const
interface KeySpec {
  key: string
  code: string
  keyCode: number
  text?: string
}
const NAMED_KEYS = new Map<string, KeySpec>([
  ["Enter", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }],
  ["Tab", { key: "Tab", code: "Tab", keyCode: 9 }],
  ["Escape", { key: "Escape", code: "Escape", keyCode: 27 }],
  ["Backspace", { key: "Backspace", code: "Backspace", keyCode: 8 }],
  ["Delete", { key: "Delete", code: "Delete", keyCode: 46 }],
  ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }],
  ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }],
  ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }],
  ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }],
  ["Home", { key: "Home", code: "Home", keyCode: 36 }],
  ["End", { key: "End", code: "End", keyCode: 35 }],
  ["PageUp", { key: "PageUp", code: "PageUp", keyCode: 33 }],
  ["PageDown", { key: "PageDown", code: "PageDown", keyCode: 34 }],
  ["Space", { key: " ", code: "Space", keyCode: 32, text: " " }],
  ...Array.from({ length: 12 }, (_, index): [string, KeySpec] => [
    `F${index + 1}`,
    { key: `F${index + 1}`, code: `F${index + 1}`, keyCode: 112 + index },
  ]),
])
const PUNCTUATION_CODES = new Map<string, [string, number]>([
  [";", ["Semicolon", 186]],
  ["=", ["Equal", 187]],
  [",", ["Comma", 188]],
  ["-", ["Minus", 189]],
  [".", ["Period", 190]],
  ["/", ["Slash", 191]],
  ["`", ["Backquote", 192]],
  ["[", ["BracketLeft", 219]],
  ["\\", ["Backslash", 220]],
  ["]", ["BracketRight", 221]],
  ["'", ["Quote", 222]],
])

function keySpec(name: string): KeySpec {
  const named = NAMED_KEYS.get(name)
  if (named) return named
  if ([...name].length !== 1)
    fault(
      "invalid-request",
      `Unknown key "${name}". Use one printable character or a named key such as Enter, Tab, Escape, Backspace, Delete, Arrow keys, Home, End, PageUp, PageDown, Space or F1-F12.`
    )
  const upper = name.toUpperCase()
  if (/^[A-Z]$/.test(upper))
    return {
      key: name,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: name,
    }
  if (/^[0-9]$/.test(name))
    return {
      key: name,
      code: `Digit${name}`,
      keyCode: name.charCodeAt(0),
      text: name,
    }
  const punctuation = PUNCTUATION_CODES.get(name)
  return {
    key: name,
    code: punctuation?.[0] ?? "",
    keyCode: punctuation?.[1] ?? 0,
    text: name,
  }
}
function modifierMask(modifiers: readonly Modifier[] | undefined): number {
  return (modifiers ?? []).reduce((mask, name) => mask | MODIFIER_BITS[name], 0)
}

function visualView(
  command: Extract<BrowserCommand, { target: BrowserTarget }>
): string | undefined {
  if (!("at" in command) || !command.at || !("view" in command.at))
    return undefined
  return command.at.view
}

interface Binding {
  capture: BrowserCapture
  owner: string
  target: BrowserTarget
  connection: BrowserConnection
  sessionId: string
  focus: BrowserFocus
  lineage: string
  intentionalDetach?: boolean
  uncertain: boolean
  mutationRevision: number
  mutations: number
  running: number
  tail: Promise<void>
  refs: Map<string, number>
  view?: string
  observation?: { token: string; digest: string; refs: string[] }
  events: BrowserProtocolEvent[]
  dialog: DialogState | null
  dialogPolicy: "ask" | "accept" | "dismiss"
  network: { enabled: boolean; inflight: Set<string> }
  downloadExports: Map<number, { directory: string; path?: string }>
  downloads: Map<string, DownloadState>
}
interface BrowserEntry {
  definition: LocalBrowser
  status: BrowserControlStatus
  connection?: BrowserConnection
  connecting?: Promise<BrowserConnection>
  connectAbort?: AbortController
  selections: Promise<void>
  endpoint?: string
}
interface OwnedTarget {
  owner: string
  browser: string
  tab: string
  connection: BrowserConnection
  browserContextId?: string
}
export type BrowserFocusPolicy = "lease" | "action" | "off"
export interface BrowserServiceOptions {
  preferencePath?: string
  defaultApplication?: () => Promise<string | undefined>
  focusPolicy?: BrowserFocusPolicy
}
const FOCUS_INPUT_ACTIONS: ReadonlySet<BrowserCommand["action"]> = new Set([
  "click",
  "hover",
  "scroll",
  "type",
  "press",
])
function fault(
  code:
    | "target-closed"
    | "target-busy"
    | "stale-target"
    | "invalid-request"
    | "disconnected"
    | "unavailable",
  message: string
): never {
  throw new BrowserFault({ code, message, outcome: "not-dispatched" })
}
function pageUrl(url: string): string {
  const parsed = z.string().url().safeParse(url).success
    ? new URL(url)
    : fault(
        "invalid-request",
        `"${url}" is not a URL. Navigation supports http, https, about and data URLs.`
      )
  if (!["http:", "https:", "about:", "data:"].includes(parsed.protocol))
    fault(
      "invalid-request",
      "Navigation supports http, https, about and data URLs."
    )
  return parsed.href
}

function browserStatus(
  definition: LocalBrowser,
  connection: BrowserControlStatus["connection"]
): BrowserControlStatus {
  const status: BrowserControlStatus = {
    id: definition.id,
    name: definition.name,
    connection: definition.setupRequired
      ? { status: "setup-required" }
      : connection,
  }
  if (definition.applicationPath)
    status.applicationPath = definition.applicationPath
  if (definition.icon) status.icon = definition.icon
  if (definition.product) status.product = definition.product
  if (definition.profileName) status.profileName = definition.profileName
  if (definition.transport) status.transport = definition.transport
  if (definition.transport === "extension" && definition.product === "Aside")
    status.guidance = asideSelectionGuidance
  if (definition.kind === "desk")
    status.guidance = "A live client of the real Mako app, not a sandbox: its clicks and edits change real conversations and settings. It refuses URLs outside its own origin."
  if (definition.kind) status.kind = definition.kind
  if (definition.profile) status.profile = definition.profile
  if (definition.origin) status.origin = definition.origin
  if (definition.sourceRoot) status.sourceRoot = definition.sourceRoot
  return status
}

/** Host-owned transport; task-owned bindings. No implicit current tab exists. */
export class BrowserService {
  private readonly recordings = new BrowserRecordings()
  private readonly browsers: Map<string, BrowserEntry>
  private readonly bindings = new Map<string, Binding>()
  private readonly ownedTargets = new Map<string, OwnedTarget>()
  private readonly listeners = new Set<
    (statuses: BrowserControlStatus[]) => void
  >()
  private readonly preference: BrowserPreferences
  private readonly defaultApplication?: () => Promise<string | undefined>
  private closing = false
  private readonly discover: () => Promise<LocalBrowser[]>
  private refreshing: Promise<BrowserControlStatus[]> | undefined
  private readonly focusPolicy: BrowserFocusPolicy
  /**
   * Applications attached at run time (`attach`): an Electron or Chromium
   * app Mako launched with a private debugging port. They live beside the
   * discovered browsers until their connection closes with the process.
   */
  private readonly attached = new Map<string, LocalBrowser>()
  private readonly attachmentOwners = new Map<string, string>()
  private readonly profileMutations = new Set<string>()
  private readonly uncertainProfiles = new Set<string>()
  private readonly browserOperations = new Map<string, number>()

  private authorizeBrowser(owner: string, browser: string): void {
    const attachedOwner = this.attachmentOwners.get(browser)
    if (attachedOwner && attachedOwner !== owner)
      fault("target-busy", "This attached application browser belongs to another task.")
    if (this.profileMutations.has(browser))
      fault("target-busy", "A profile-wide cookie operation is pending. Wait for it before using this browser.")
  }

  constructor(
    definitions?:
      LocalBrowser[] | (() => LocalBrowser[] | Promise<LocalBrowser[]>),
    options: BrowserServiceOptions = {}
  ) {
    const discover =
      definitions === undefined
        ? localBrowsers
        : Array.isArray(definitions)
          ? () => definitions
          : definitions
    this.discover = async () => [
      ...(await discover()),
      ...this.attached.values(),
    ]
    this.preference = new BrowserPreferences(options.preferencePath)
    this.defaultApplication = options.defaultApplication
    this.focusPolicy = options.focusPolicy ?? "action"
    this.browsers = new Map(
      (Array.isArray(definitions) ? definitions : []).map((definition) => [
        definition.id,
        {
          definition,
          selections: Promise.resolve(),
          status: browserStatus(definition, {
            status: "disconnected",
          }),
        },
      ])
    )
  }

  status(): BrowserControlStatus[] {
    const selected = this.preference.value
    const statuses = Array.from(this.browsers.values(), (entry) => ({
      ...entry.status,
      preferred: entry.definition.id === selected?.id,
    }))
    if (selected && !this.browsers.has(selected.id)) {
      const application = statuses.find(
        (status) =>
          status.connection.status === "setup-required" &&
          selected.applicationPath &&
          status.applicationPath === selected.applicationPath
      )
      if (application) statuses.splice(statuses.indexOf(application), 1)
      statuses.push({
        ...selected,
        icon: application?.icon,
        kind: "chromium",
        preferred: true,
        connection: {
          status: "unavailable",
          reason:
            selected.transport === "direct"
              ? "This preferred direct connection is not available. Open its browser or choose another profile."
              : "This preferred profile is not available. Open its browser and enable Mako Browser, or choose another profile.",
        },
      })
    }
    return statuses
  }
  refresh(): Promise<BrowserControlStatus[]> {
    this.refreshing ??= this.refreshCatalog().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }
  private async refreshCatalog(): Promise<BrowserControlStatus[]> {
    const [definitions] = await Promise.all([
      this.discover(),
      this.preference.load(),
    ])
    if (this.closing) return this.status()
    const available = new Set(definitions.map((definition) => definition.id))
    let changed = false
    for (const [id, entry] of this.browsers) {
      if (!available.has(id) && !entry.connection && !entry.connecting) {
        this.browsers.delete(id)
        changed = true
      }
    }
    for (const definition of definitions) {
      const entry = this.browsers.get(definition.id)
      if (entry) {
        entry.definition = definition
        if (
          entry.status.icon !== definition.icon ||
          entry.status.applicationPath !== definition.applicationPath ||
          entry.status.product !== definition.product ||
          entry.status.profileName !== definition.profileName ||
          entry.status.transport !== definition.transport ||
          entry.status.guidance !==
            browserStatus(definition, entry.status.connection).guidance ||
          entry.status.name !== definition.name ||
          entry.status.kind !== definition.kind ||
          entry.status.profile !== definition.profile ||
          entry.status.origin !== definition.origin ||
          entry.status.sourceRoot !== definition.sourceRoot
        ) {
          entry.status = {
            ...browserStatus(definition, entry.status.connection),
            lastInterruption: entry.status.lastInterruption,
          }
          changed = true
        }
      } else {
        this.browsers.set(definition.id, {
          definition,
          selections: Promise.resolve(),
          status: browserStatus(definition, {
            status: "disconnected",
          }),
        })
        changed = true
      }
    }
    const selected = this.preference.value
    const selectedDefinition = selected
      ? this.browsers.get(selected.id)?.definition
      : undefined
    if (
      selected &&
      !selected.applicationPath &&
      selectedDefinition?.applicationPath
    ) {
      await this.preference.set({
        ...selected,
        applicationPath: selectedDefinition.applicationPath,
      })
      changed = true
    }
    if (selected?.setupRequired && selected.applicationPath) {
      const profiles = definitions.filter(
        (browser) =>
          !browser.setupRequired &&
          browser.transport === "extension" &&
          browser.applicationPath === selected.applicationPath
      )
      // Selection before setup grants no authority to an ambiguous profile.
      if (profiles.length === 1 && this.preference.value === selected) {
        const profile = profiles[0]!
        await this.preference.set({
          id: profile.id,
          name: profile.name,
          product: profile.product,
          profileName: profile.profileName,
          transport: profile.transport,
          applicationPath: profile.applicationPath,
        })
        changed = true
      }
    }
    if (!this.preference.hasSavedChoice && this.defaultApplication) {
      const applicationPath = await this.defaultApplication()
      // Several profiles in the same browser are ambiguous. Never pick the first.
      const candidates = applicationPath
        ? definitions.filter(
            (definition) =>
              definition.transport === "extension" &&
              definition.applicationPath === applicationPath
          )
        : []
      if (
        !this.closing &&
        !this.preference.hasSavedChoice &&
        candidates.length === 1
      ) {
        const browser = candidates[0]!
        await this.preference.set({
          id: browser.id,
          name: browser.name,
          product: browser.product,
          applicationPath: browser.applicationPath,
          setupRequired: browser.setupRequired,
          profileName: browser.profileName,
          transport: browser.transport,
        })
        changed = true
      }
    }
    if (changed) this.changed()
    return this.status()
  }
  subscribe(listener: (statuses: BrowserControlStatus[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(): void {
    for (const listener of this.listeners) listener(this.status())
  }
  private entry(id: string): BrowserEntry {
    const entry = this.browsers.get(id)
    if (entry) return entry
    if (this.browsers.size === 0)
      fault(
        "unavailable",
        "No browser is connected to Mako. Install the Mako Browser extension and connect a profile in Settings > MCP > Browser use, then call status again."
      )
    return fault(
      "invalid-request",
      `Unknown browser "${id}". Choose a browser ID returned by status: ${[...this.browsers.keys()].join(", ")}.`
    )
  }

  async prefer(id: string | null): Promise<BrowserControlStatus[]> {
    await this.refresh()
    if (id === null) await this.preference.set(null)
    else {
      const entry = this.entry(id)
      if (entry.definition.kind !== "chromium")
        fault("invalid-request", "Choose an external browser profile.")
      await this.preference.set({
        id,
        name: entry.definition.name,
        product: entry.definition.product,
        applicationPath: entry.definition.applicationPath,
        setupRequired: entry.definition.setupRequired,
        profileName: entry.definition.profileName,
        transport: entry.definition.transport,
      })
    }
    this.changed()
    return this.status()
  }

  connect(id: string): Promise<BrowserConnection> {
    if (this.closing)
      fault("disconnected", "Mako browser control is shutting down.")
    const entry = this.entry(id)
    if (entry.definition.setupRequired)
      fault(
        "unavailable",
        `Open ${entry.definition.name} and add the Mako Browser extension to use it.`
      )
    if (entry.connection) return Promise.resolve(entry.connection)
    if (!entry.connecting) {
      const abort = new AbortController()
      entry.connectAbort = abort
      entry.connecting = this.start(entry, abort).finally(() => {
        if (entry.connectAbort === abort) {
          entry.connecting = undefined
          entry.connectAbort = undefined
        }
      })
    }
    return entry.connecting
  }

  private async start(
    entry: BrowserEntry,
    abort: AbortController
  ): Promise<BrowserConnection> {
    let opened: BrowserConnection | undefined
    try {
      const endpoint = await entry.definition.endpoint()
      abort.signal.throwIfAborted()
      if ([...this.browsers.values()].some((other) => other !== entry && other.endpoint === endpoint))
        fault("target-busy", "This browser endpoint is already registered. Use its existing browser ID; aliases cannot create independent ownership.")
      entry.endpoint = endpoint
      entry.status = {
        ...entry.status,
        connection:
          entry.definition.requiresApproval === false
            ? { status: "connecting" }
            : { status: "awaiting-approval", startedAt: Date.now() },
      }
      this.changed()
      const connection = await BrowserConnection.connect(endpoint, abort.signal)
      opened = connection
      if (this.closing) {
        connection.close()
        fault("disconnected", "Mako browser control closed during connection.")
      }
      connection.onClose(() => {
        if (entry.connection !== connection) return
        entry.connection = undefined
        entry.status = {
          ...entry.status,
          connection: { status: "disconnected" },
        }
        for (const [key, binding] of this.bindings) {
          if (binding.connection !== connection) continue
          entry.status.lastInterruption = {
            tab: binding.target.tab,
            message:
              "The browser connection ended. An in-flight action may have completed. Reconnect, claim the exact tab and observe before deciding what to do; no action was replayed.",
          }
          this.recordings.stopTarget(
            binding.owner,
            binding.target,
            "Tab lease ended"
          )
          this.endBinding(this.bindings.get(key), "Tab binding ended")
          this.bindings.delete(key)
        }
        for (const [key, target] of this.ownedTargets)
          if (target.connection === connection) this.ownedTargets.delete(key)
        // An attached application that closed its endpoint has exited; its
        // row would otherwise offer a connection to nothing.
        if (this.attached.delete(entry.definition.id)) {
          this.browsers.delete(entry.definition.id)
          this.attachmentOwners.delete(entry.definition.id)
          this.uncertainProfiles.delete(entry.definition.id)
        }
        this.changed()
      })
      connection.onEvent((event) => this.event(connection, event))
      await connection.send(
        "Target.setDiscoverTargets",
        { discover: true },
        AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)])
      )
      abort.signal.throwIfAborted()
      entry.connection = connection
      entry.status = {
        ...entry.status,
        connection: { status: "connected", generation: connection.generation },
      }
      this.changed()
      return connection
    } catch (error) {
      opened?.close()
      if (entry.connectAbort === abort) {
        entry.status = {
          ...entry.status,
          connection: {
            status: "unavailable",
            reason:
              error instanceof Error
                ? error.message
                : "Browser connection failed",
          },
        }
        this.changed()
      }
      throw error
    }
  }

  private event(
    connection: BrowserConnection,
    event: BrowserProtocolEvent
  ): void {
    if (event.method === "Page.screencastFrame") return

    if (event.method === "Target.targetCreated") {
      const child = z.object({ targetInfo }).safeParse(event.params)
      if (child.success && child.data.targetInfo.makoTaskLifetime) {
        const info = child.data.targetInfo
        const parent = [...this.ownedTargets.values()].find(
          (t) =>
            t.connection === connection &&
            t.tab === info.openerId &&
            t.owner === info.makoOwner
        )
        if (parent)
          this.ownedTargets.set(
            this.key({ browser: parent.browser, tab: info.targetId }),
            { ...parent, tab: info.targetId }
          )
      }
    }
    if (event.method === "Target.targetDestroyed") {
      // Destruction can arrive after detach already removed the binding.
      for (const [key, target] of this.ownedTargets)
        if (
          target.connection === connection &&
          target.tab === event.params.targetId
        )
          this.ownedTargets.delete(key)
    }
    for (const [key, binding] of this.bindings) {
      if (binding.connection !== connection) continue
      if (
        event.method === "Target.targetDestroyed" &&
        event.params.targetId === binding.target.tab
      ) {
        this.recordings.stopTarget(
          binding.owner,
          binding.target,
          "Tab lease ended"
        )
        this.endBinding(this.bindings.get(key), "Tab binding ended")
        this.bindings.delete(key)
        this.ownedTargets.delete(key)
        continue
      }
      if (
        event.method === "Target.detachedFromTarget" &&
        event.params.sessionId === binding.sessionId
      ) {
        const entry = this.browsers.get(binding.target.browser)
        if (entry && !binding.intentionalDetach) {
          entry.status = {
            ...entry.status,
            lastInterruption: {
              tab: binding.target.tab,
              message: tabInterruption(
                binding.events,
                z.string().safeParse(event.params.reason).data
              ),
            },
          }
          this.changed()
        }
        this.recordings.stopTarget(
          binding.owner,
          binding.target,
          "Tab lease ended"
        )
        this.endBinding(this.bindings.get(key), "Tab binding ended")
        this.bindings.delete(key)
        continue
      }
      if (event.sessionId !== binding.sessionId) continue
      this.trackPageEvent(binding, event)
      // Only a main-frame navigation replaces the document the refs came from;
      // an advertisement iframe loading must not invalidate the page's refs.
      if (event.method === "Page.frameNavigated") {
        const frame = mainFrame.safeParse(event.params)
        if (!frame.success || frame.data.frame.parentId === undefined) {
          binding.lineage = randomUUID()
          binding.refs.clear()
          binding.view = undefined
          binding.observation = undefined
        }
      }
      const bounded =
        JSON.stringify(event.params).length > EVENT_ENTRY_BYTES
          ? { ...event, params: { truncated: true } }
          : event
      binding.events.push(bounded)
      if (binding.events.length > EVENT_ENTRY_LIMIT) binding.events.shift()
    }
  }

  /** Dialogs, in-flight requests and downloads the tab reports between commands. */
  private trackPageEvent(binding: Binding, event: BrowserProtocolEvent): void {
    switch (event.method) {
      case "Page.javascriptDialogOpening": {
        const dialog = dialogOpening.safeParse(event.params)
        if (!dialog.success) return
        binding.dialog = { ...dialog.data, openedAt: Date.now() }
        void binding.focus.setDialogOpen(true)
        if (binding.dialogPolicy === "ask") return
        const accept = binding.dialogPolicy === "accept"
        void binding.connection
          .send(
            "Page.handleJavaScriptDialog",
            { accept },
            AbortSignal.timeout(5000),
            binding.sessionId
          )
          .then(
            () => {
              binding.connection.emitLocal(
                "mako.dialogAutoHandled",
                { ...dialog.data, accept },
                binding.sessionId
              )
            },
            () => {
              /* The dialog stays open for an explicit answer. */
            }
          )
        return
      }
      case "Page.javascriptDialogClosed":
        binding.dialog = null
        void binding.focus.setDialogOpen(false).catch(() => {
          binding.uncertain = true
          binding.connection.emitLocal("mako.focusRestoreFailed", {
            message: "Focus restoration failed after the dialog closed; the attachment was ended. Observe browser status before continuing.",
          }, binding.sessionId)
        })
        return
      case "Network.requestWillBeSent": {
        const request = requestEvent.safeParse(event.params)
        if (request.success)
          binding.network.inflight.add(request.data.requestId)
        return
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const request = requestEvent.safeParse(event.params)
        if (request.success)
          binding.network.inflight.delete(request.data.requestId)
        return
      }
      case "Page.downloadWillBegin":
      case "Browser.downloadWillBegin": {
        const begin = downloadBegin.safeParse(event.params)
        if (begin.success)
          binding.downloads.set(begin.data.guid, {
            ...begin.data,
            state: "inProgress",
          })
        return
      }
      case "Page.downloadProgress":
      case "Browser.downloadProgress": {
        const progress = downloadProgress.safeParse(event.params)
        if (!progress.success) return
        const current = binding.downloads.get(progress.data.guid)
        binding.downloads.set(progress.data.guid, {
          ...(current ?? { guid: progress.data.guid }),
          ...progress.data,
        })
        return
      }
      default:
        return
    }
  }

  private connection(id: string): BrowserConnection {
    const connection = this.entry(id).connection
    if (!connection)
      fault(
        "disconnected",
        "Call control.connectBrowser(id) for this exact browser first. Discovery and actions never initiate or retry a connection."
      )
    return connection
  }
  private key(target: Pick<BrowserTarget, "browser" | "tab">): string {
    return `${target.browser}:${target.tab}`
  }

  private select(
    owner: string,
    browser: string,
    tab: string,
    takeover: boolean,
    signal: AbortSignal
  ): Promise<BrowserTarget> {
    const entry = this.entry(browser)
    const result = entry.selections.then(() => {
      signal.throwIfAborted()
      this.authorizeBrowser(owner, browser)
      return this.attach(owner, browser, tab, takeover, signal)
    })
    entry.selections = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  private async attach(
    owner: string,
    browser: string,
    tab: string,
    takeover: boolean,
    signal: AbortSignal
  ): Promise<BrowserTarget> {
    const connection = this.connection(browser)
    const target = {
      browser,
      tab,
      generation: connection.generation,
      lease: randomUUID(),
    }
    const key = this.key(target)
    const existing = this.bindings.get(key)
    const owned = this.ownedTargets.get(key)
    if (existing?.owner === owner) return existing.target
    if (!existing && this.bindings.size >= 512)
      fault(
        "invalid-request",
        "Release unused tab bindings before opening more."
      )
    if (existing && (!takeover || existing.running > 0))
      fault(
        "target-busy",
        "Another task owns this tab. Choose another tab, or explicitly take over after its action finishes."
      )
    if (owned && owned.owner !== owner && !takeover)
      fault(
        "target-busy",
        "Another task owns this temporary browser resource. Choose another target, or explicitly take it over."
      )
    const info = z
      .object({ targetInfo })
      .parse(
        await connection.send("Target.getTargetInfo", { targetId: tab }, signal)
      )
    if (
      info.targetInfo.makoOwner &&
      info.targetInfo.makoOwner !== owner &&
      !takeover
    )
      fault(
        "target-busy",
        "Another task owns this child tab. Claim it only after an explicit takeover."
      )
    const page = PAGE_TARGET_TYPES.has(info.targetInfo.type)
    if (!page)
      fault(
        "invalid-request",
        `Target ${tab} is a ${info.targetInfo.type}, not a page. Select a page target from tabs; workers and service workers accept no page input.`
      )
    if (existing) {
      await existing.focus.close()
      existing.intentionalDetach = true
      try {
        await connection.send(
          "Target.detachFromTarget",
          { sessionId: existing.sessionId },
          signal
        )
      } finally {
        existing.intentionalDetach = false
      }
      this.recordings.stopTarget(
        existing.owner,
        existing.target,
        "Tab lease ended"
      )
      this.endBinding(this.bindings.get(key), "Tab binding ended")
      this.bindings.delete(key)
    }
    const attachParameters: JsonObject = { targetId: tab, flatten: true }
    if (this.entry(browser).definition.transport === "extension")
      attachParameters.makoOwner = owner
    const { sessionId } = sessionResult.parse(
      await connection.send("Target.attachToTarget", attachParameters, signal)
    )
    try {
      await connection.send("Page.enable", {}, signal, sessionId)
      const focus = new BrowserFocus(connection, sessionId)
      if (this.focusPolicy === "lease") await focus.acquire(signal)
      this.bindings.set(key, {
        capture: new BrowserCapture(
          connection, sessionId, this.focusPolicy === "off" ? undefined : focus
        ),
        owner,
        target,
        connection,
        sessionId,
        focus,
        lineage: randomUUID(),
        uncertain: this.uncertainProfiles.has(browser),
        mutationRevision: 0,
        mutations: 0,
        running: 0,
        tail: Promise.resolve(),
        refs: new Map(),
        events: [],
        dialog: null,
        dialogPolicy: "ask",
        network: { enabled: false, inflight: new Set() },
        downloads: new Map(),
        downloadExports: new Map(),
      })
      if (owned) owned.owner = owner
    } catch (error) {
      await connection
        .send(
          "Target.detachFromTarget",
          { sessionId },
          AbortSignal.timeout(2000)
        )
        .catch(() => {})
      throw error
    }
    return target
  }

  private endBinding(binding: Binding | undefined, reason: string) {
    if (!binding) return
    binding.capture.end(reason)
    void binding.focus.close().catch(() => {})
  }

  /** UI consumers share the tab's compositor stream, independent of agent observations. */
  async previewStream(
    owner: string, target: BrowserTarget, authorize: () => void,
    frame: (value: BrowserFrame) => void, ended: (reason: string) => void
  ) {
    authorize()
    const binding = this.binding(owner, target)
    return binding.capture.subscribe({
      frame: value => { authorize(); frame(value) }, ended,
    })
  }

  async execute(
    owner: string,
    command: BrowserCommand,
    signal: AbortSignal,
    authorize: () => void = () => {}
  ): Promise<JsonValue> {
    authorize()
    signal.throwIfAborted()
    if (command.action === "open" && !command.browser) {
      await this.preference.load()
      command = { ...command, browser: this.preference.value?.id }
    }
    const browser = "target" in command ? undefined
      : "browser" in command ? command.browser
        : "id" in command ? command.id : undefined
    if (browser) {
      this.authorizeBrowser(owner, browser)
      this.browserOperations.set(browser, (this.browserOperations.get(browser) ?? 0) + 1)
    }
    try { return await this.executeCommand(owner, command, signal, authorize) }
    finally {
      if (browser) {
        const remaining = (this.browserOperations.get(browser) ?? 1) - 1
        if (remaining) this.browserOperations.set(browser, remaining)
        else this.browserOperations.delete(browser)
      }
    }
  }

  private async executeCommand(
    owner: string,
    command: BrowserCommand,
    signal: AbortSignal,
    authorize: () => void
  ): Promise<JsonValue> {
    authorize()
    signal.throwIfAborted()
    if (command.action === "status")
      return (await this.refresh()).map(({ icon, ...status }) => {
        // Native app icons belong to Settings, not model context.
        void icon
        return { ...status, connection: { ...status.connection } }
      })
    const browserId = "target" in command ? command.target.browser
      : "browser" in command ? command.browser
        : "id" in command ? command.id : undefined
    if (browserId) this.authorizeBrowser(owner, browserId)
    if (command.action === "connect") {
      if (!this.browsers.has(command.browser)) await this.refresh()
      await this.connect(command.browser)
      return { ...this.entry(command.browser).status.connection }
    }
    if (command.action === "attach") {
      const endpoint = new URL(command.endpoint)
      if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1")
        fault(
          "invalid-request",
          "An attached application's endpoint must be ws://127.0.0.1:<port>/…; Mako never attaches a remote endpoint."
        )
      const previous = this.browsers.get(command.id)
      if (previous)
        fault(
          "invalid-request",
          `Application browser "${command.id}" is already attached. Detach that exact generation before reusing its id.`
        )
      this.attachmentOwners.set(command.id, owner)
      this.attached.set(command.id, {
        id: command.id,
        name: command.name,
        requiresApproval: false,
        endpoint: async () => endpoint.href,
      })
      await this.refresh()
      try {
        await this.connect(command.id)
      } catch (error) {
        this.attached.delete(command.id)
        this.attachmentOwners.delete(command.id)
        this.browsers.delete(command.id)
        this.changed()
        throw error
      }
      return { ...this.entry(command.id).status }
    }
    if (command.action === "detach") {
      const entry = this.browsers.get(command.id)
      if (!entry || !this.attached.has(command.id))
        return { id: command.id, detached: false }
      entry.connectAbort?.abort()
      entry.connection?.close()
      for (const [key, binding] of this.bindings)
        if (binding.target.browser === command.id) {
          this.recordings.stopTarget(
            binding.owner,
            binding.target,
            "Tab lease ended"
          )
          this.endBinding(this.bindings.get(key), "Tab binding ended")
          this.bindings.delete(key)
        }
      for (const [key, target] of this.ownedTargets)
        if (target.browser === command.id) this.ownedTargets.delete(key)
      this.attached.delete(command.id)
      this.attachmentOwners.delete(command.id)
      this.uncertainProfiles.delete(command.id)
      this.browsers.delete(command.id)
      this.changed()
      return { id: command.id, detached: true }
    }
    if (command.action === "tabs") {
      const result = targetsResult.parse(
        await this.connection(command.browser).send(
          "Target.getTargets",
          {},
          signal
        )
      )
      return result.targetInfos.map((tab) => ({
        ...tab,
        selectable: PAGE_TARGET_TYPES.has(tab.type),
        claimed:
          this.bindings.has(
            this.key({ browser: command.browser, tab: tab.targetId })
          ) ||
          this.ownedTargets.has(
            this.key({ browser: command.browser, tab: tab.targetId })
          ),
      }))
    }
    if (command.action === "select")
      return {
        ...(await this.select(
          owner,
          command.browser,
          command.tab,
          command.takeover,
          signal
        )),
      }
    if (command.action === "open") {
      if (this.bindings.size >= 512 || this.ownedTargets.size >= 512)
        fault(
          "invalid-request",
          "Close unused temporary targets before opening more pages."
        )
      await this.preference.load()
      const browser = command.browser ?? this.preference.value?.id
      if (!browser)
        fault(
          "invalid-request",
          "Choose a preferred browser in Settings, or pass an explicit browser ID."
        )
      const url = pageUrl(command.url)
      this.authorizeBrowser(owner, browser)
      const connection = this.connection(browser)
      if (command.context === "isolated" && command.lifetime === "persistent")
        fault(
          "invalid-request",
          "An isolated browser context must use task lifetime so Mako can dispose it completely."
        )
      let browserContextId: string | undefined
      if (command.context === "isolated") {
        try {
          browserContextId = z
            .object({ browserContextId: z.string() })
            .parse(
              await connection.send(
                "Target.createBrowserContext",
                { disposeOnDetach: true },
                signal
              )
            ).browserContextId
        } catch (error) {
          if (signal.aborted) throw error
          fault(
            "unavailable",
            "This browser transport cannot create isolated contexts. Use context:profile, or attach a direct CDP browser endpoint."
          )
        }
      }
      let targetId: string
      try {
        const targetParameters: JsonObject = {
          url: this.entry(browser).definition.kind === "desk" ? url : "about:blank",
          background: command.background,
          newWindow: command.disposition === "window",
        }
        if (this.entry(browser).definition.transport === "extension") {
          targetParameters.makoTaskLifetime = command.lifetime === "task"
          targetParameters.makoOwner = owner
          targetParameters.makoTaskName = command.name ?? "Mako"
        }
        if (browserContextId)
          targetParameters.browserContextId = browserContextId
        targetId = z
          .object({ targetId: z.string() })
          .parse(
            await connection.send(
              "Target.createTarget",
              targetParameters,
              signal
            )
          ).targetId
      } catch (error) {
        if (browserContextId)
          await connection
            .send(
              "Target.disposeBrowserContext",
              { browserContextId },
              AbortSignal.timeout(2000)
            )
            .catch(() => {})
        throw error
      }
      let target: BrowserTarget
      try {
        target = await this.select(owner, browser, targetId, false, signal)
      } catch (error) {
        if (browserContextId)
          await connection
            .send(
              "Target.disposeBrowserContext",
              { browserContextId },
              AbortSignal.timeout(2000)
            )
            .catch(() => {})
        else
          await connection
            .send("Target.closeTarget", { targetId }, AbortSignal.timeout(2000))
            .catch(() => {})
        throw error
      }
      if (command.lifetime === "task")
        this.ownedTargets.set(this.key(target), {
          owner,
          browser: target.browser,
          tab: target.tab,
          connection,
          browserContextId,
        })
      if (url === "about:blank") return { ...target }
      // The tab exists and is bound whatever the navigation does; return the
      // handle with the navigation's outcome rather than losing the tab.
      try {
        const navigation = await this.execute(
          owner,
          { action: "navigate", target, url },
          signal,
          authorize
        )
        return { ...target, navigation }
      } catch (error) {
        if (!(error instanceof BrowserFault)) throw error
        return { ...target, navigation: { fault: error.detail } }
      }
    }
    if (command.action === "recording" && command.operation !== "start") {
      authorize()
      const recording = this.recordings.get(
        owner,
        command.target,
        z.string().parse(command.id)
      )
      return z
        .json()
        .parse(
          command.operation === "stop"
            ? await recording.stop()
            : recording.receipt()
        )
    }
    const binding = this.binding(owner, command.target)
    const run = async () => {
      authorize()
      this.binding(owner, command.target)
      this.authorizeBrowser(owner, command.target.browser)
      signal.throwIfAborted()
      const effect = browserCommandEffect(command)
      const observation =
        effect === "read" || effect === "observe" || effect === "release"
      const view = visualView(command)
      if (view !== undefined && binding.view !== view)
        throw new BrowserFault({
          code: "stale-target",
          message:
            "These coordinates belong to an earlier visual view of this tab. Capture it again and use the new view token.",
          outcome: "not-dispatched",
        })
      const answeringDialog =
        command.action === "dialog" &&
        command.respond !== undefined &&
        command.auto === undefined &&
        binding.dialog !== null
      if (binding.uncertain && !observation && !answeringDialog)
        throw new BrowserFault({
          code: "outcome-unknown",
          message:
            "The previous action's outcome is unknown. Observe or capture this exact target before taking another action.",
          outcome: "not-dispatched",
        })
      if (
        binding.dialog &&
        !["dialog", "events", "release", "close", "recording"].includes(
          command.action
        )
      )
        throw new BrowserFault({
          code: "target-busy",
          message: `A ${binding.dialog.type} dialog is open on this tab: "${binding.dialog.message.slice(0, 200)}". Answer it with the dialog tool (respond accept or dismiss) before other actions; set auto to answer future dialogs automatically.`,
          outcome: "not-dispatched",
        })
      if (effect === "observe" && binding.mutations > 0)
        fault("target-busy", "Wait for this tab's pending mutation before observing it.")
      const revision = binding.mutationRevision
      const mutating = effect === "mutate" || effect === "release"
      if (mutating) {
        binding.mutationRevision++
        binding.mutations++
      }
      const profileMutation = command.action === "cookies" && command.operation !== "list"
      if (profileMutation) {
        const peers = [...this.bindings.values()].filter((peer) => peer.target.browser === binding.target.browser)
        const foreignTarget = [...this.ownedTargets.values()].some((target) => target.browser === binding.target.browser && target.owner !== owner)
        if (this.browserOperations.has(binding.target.browser) || foreignTarget || peers.some((peer) => peer.owner !== owner || peer.running > 0)) {
          if (mutating) binding.mutations--
          fault("target-busy", "Cookie writes affect the browser profile. Other tasks own tabs or actions are pending; use a separately owned browser for this operation.")
        }
        this.profileMutations.add(binding.target.browser)
        for (const peer of peers) {
          peer.refs.clear()
          peer.view = undefined
          peer.observation = undefined
        }
      }
      binding.running++
      try {
        const value = await this.withActionFocus(binding, command, signal, () =>
          this.bound(binding, command, signal)
        )
        if (
          !["close", "release"].includes(command.action) &&
          this.bindings.get(this.key(binding.target)) !== binding
        )
          throw new BrowserFault({
            code: "target-closed",
            message:
              "The exact tab closed after the command was dispatched. Its outcome is unknown; no command was retried and no other tab was selected.",
            outcome: "unknown",
          })
        if (!observation && signal.aborted)
          throw new BrowserFault({
            code: "cancelled",
            message: "The command completed after cancellation. Observe this exact tab before continuing.",
            outcome: "unknown",
          })
        if (effect === "observe") {
          if (binding.mutations > 0 || binding.mutationRevision !== revision) {
            binding.uncertain = true
            binding.view = undefined
            binding.refs.clear()
            throw new BrowserFault({
              code: "outcome-unknown",
              message: "This observation overlapped a mutation. Read the exact tab again after its pending action completes.",
              outcome: "unknown",
            })
          }
          binding.uncertain = false
        }
        if (effect === "mutate" || effect === "release") binding.view = undefined
        return value
      } catch (error) {
        if (
          error instanceof BrowserFault &&
          /Session with given id not found|No target with given id|Target closed/i.test(
            error.message
          )
        ) {
          this.recordings.stopTarget(
            binding.owner,
            binding.target,
            "Tab lease ended"
          )
          this.endBinding(binding, "Tab binding ended")
          this.bindings.delete(this.key(binding.target))
          throw new BrowserFault({
            code: "target-closed",
            message:
              "The exact tab session closed. No command was retried and no other tab was selected.",
            outcome: error.detail.outcome,
          })
        }
        if (
          !observation &&
          (!(error instanceof BrowserFault) || error.detail.outcome === "unknown")
        ) {
          binding.uncertain = true
          binding.view = undefined
          if (profileMutation) {
            this.uncertainProfiles.add(binding.target.browser)
            for (const peer of this.bindings.values())
              if (peer.target.browser === binding.target.browser) peer.uncertain = true
          }
        }
        throw error
      } finally {
        binding.intentionalDetach = false
        binding.running--
        if (mutating) binding.mutations--
        if (profileMutation) this.profileMutations.delete(binding.target.browser)
      }
    }
    // Explicit concurrent CDP lets a task answer paused Fetch requests or dialogs
    // while its navigation is waiting. The exact owner and lease still apply.
    if (
      command.action === "events" ||
      command.action === "dialog" ||
      (command.action === "cdp" && command.concurrent)
    )
      return run()
    const result = binding.tail.then(run)
    binding.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private binding(owner: string, target: BrowserTarget): Binding {
    const connection = this.connection(target.browser)
    if (connection.generation !== target.generation)
      fault(
        "stale-target",
        "This target belongs to an earlier browser connection. List and select the exact page again."
      )
    const binding = this.bindings.get(this.key(target))
    if (!binding)
      fault(
        "target-closed",
        "This tab binding is closed or released. No other tab was selected."
      )
    if (binding.owner !== owner)
      fault("target-busy", "This tab is owned by another task.")
    if (binding.target.lease !== target.lease)
      fault(
        "stale-target",
        "This handle belongs to an earlier claim of the tab. Use the handle returned by your latest select call."
      )
    return binding
  }

  private async withActionFocus<T>(
    binding: Binding,
    command: Extract<BrowserCommand, { target: BrowserTarget }>,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    if (
      this.focusPolicy !== "action" ||
      !FOCUS_INPUT_ACTIONS.has(command.action)
    )
      return operation()
    const release = await binding.focus.acquire(signal)
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  private async bound(
    binding: Binding,
    command: Extract<BrowserCommand, { target: BrowserTarget }>,
    signal: AbortSignal
  ): Promise<JsonValue> {
    const send = async (method: string, params: JsonObject = {}) => {
      try {
        return method.startsWith("Input.")
          ? await this.input(binding, method, params, signal)
          : await binding.connection.send(method, params, signal, binding.sessionId)
      } catch (error) {
        if (error instanceof BrowserFault)
          throw new BrowserFault({
            ...error.detail,
            message: `${method}: ${error.detail.message}`,
          })
        throw error
      }
    }
    const root = (method: string, params: JsonObject) =>
      binding.connection.send(method, params, signal)
    switch (command.action) {
      case "capabilities": {
        const transport =
          this.entry(binding.target.browser).definition.transport ?? "direct"
        const extension = transport === "extension"
        return {
          target: binding.target,
          transport,
          scopedObservation: true,
          semanticLocators: true,
          dialogs: true,
          children: true,
          retainedResults: !this.ownedTargets.get(this.key(binding.target))
            ?.browserContextId,
          downloads: extension
            ? {
                url: true,
                ref: false,
                completion: "browser-download-id",
                continuation: "downloadStatus(id)",
              }
            : { url: true, ref: true, completion: "protocol-events" },
          cursor: extension,
          recording: {
            state: "preflight-required",
            scope: "exact-tab",
            pageFocus: this.focusPolicy === "off"
              ? "unchanged; hidden pages may not paint"
              : this.focusPolicy === "lease"
                ? "emulated for the tab lease; never activates the tab"
                : "emulated during capture; disabled after the last consumer; never activates the tab",
            cursor: "dispatched-pointer",
            requires: ["ffmpeg", "ffprobe"],
            completion: "record().stop() then recording.status()",
          },
          taskGroups: extension,
          isolatedContexts: !extension,
        }
      }
      case "children": {
        const result = targetsResult.parse(await root("Target.getTargets", {}))
        return {
          children: result.targetInfos
            .filter((t) => t.openerId === binding.target.tab)
            .map((t) => ({
              browser: binding.target.browser,
              tab: t.targetId,
              title: t.title,
              url: t.url,
            })),
          note: "Claim the exact child tab before acting. A page-created popup may activate a browser window.",
        }
      }
      case "retain": {
        const key = this.key(binding.target)
        const owned = this.ownedTargets.get(key)
        if (!owned || owned.owner !== binding.owner)
          fault("invalid-request", "Only a task-owned tab can be retained.")
        if (owned.browserContextId)
          fault(
            "invalid-request",
            "An isolated-context tab cannot outlive its task."
          )
        if (
          this.entry(binding.target.browser).definition.transport ===
          "extension"
        )
          await send("Mako.retainTarget", { name: command.name })
        this.ownedTargets.delete(key)
        return { retained: true, name: command.name, target: binding.target }
      }
      case "recording": {
        return z
          .json()
          .parse(
            await this.recordings.start(
              binding.owner,
              binding.target,
              binding.connection,
              binding.sessionId,
              command.options ?? {},
              signal,
              binding.capture
            )
          )
      }
      case "observe": {
        const lineage = binding.lineage
        const info = await root("Target.getTargetInfo", {
          targetId: binding.target.tab,
        })
        const scoped = command.within.length > 0 || command.match !== undefined
        const readTree = async () => {
          if (!scoped)
            return send(
              "Accessibility.getFullAXTree",
              command.frameId ? { frameId: command.frameId } : {}
            )
          if (command.frameId)
            fault(
              "invalid-request",
              "Scoped reads currently require the selected page's main frame; select an out-of-process frame as its own tab or use an explicit frame observation."
            )
          const visibility = z
            .object({
              result: z.object({ value: z.enum(["visible", "hidden"]) }),
            })
            .parse(
              await send("Runtime.evaluate", {
                expression: "document.visibilityState",
                returnByValue: true,
              })
            ).result.value
          if (visibility === "hidden") {
            // queryAXTree waits for a visual lifecycle update, which Chromium
            // can throttle for occluded pages. A synchronous snapshot remains
            // read-only and does not activate or change focus on the page.
            const snapshot = z
              .object({ nodes: z.array(AccessibilityNodeSchema) })
              .parse(await send("Accessibility.getFullAXTree"))
            return { nodes: scopeAccessibilityNodes(snapshot.nodes, command) }
          }
          const document = z
            .object({ root: z.object({ backendNodeId: z.number() }) })
            .parse(await send("DOM.getDocument", { depth: 0 }))
          let backendNodeId = document.root.backendNodeId
          for (const scope of command.within) {
            const result = z
              .object({ nodes: z.array(AccessibilityNodeSchema) })
              .parse(
                await send("Accessibility.queryAXTree", {
                  backendNodeId,
                  role: scope.role,
                  accessibleName: scope.name,
                })
              )
            const matches = result.nodes.filter(
              (node) =>
                node.backendDOMNodeId !== backendNodeId &&
                !node.ignored &&
                node.role?.value === scope.role &&
                (node.name?.value ?? "") === scope.name
            )
            if (matches.length !== 1 || !matches[0]?.backendDOMNodeId)
              fault(
                "invalid-request",
                `Scope requires one ${scope.role} ${JSON.stringify(scope.name)}; found ${matches.length}. Observe and disambiguate the container.`
              )
            backendNodeId = matches[0]!.backendDOMNodeId!
          }
          const params: JsonObject = { backendNodeId }
          if (command.match) {
            params.role = command.match.role
            params.accessibleName = command.match.name
          }
          const subtree = z
            .object({ nodes: z.array(AccessibilityNodeSchema) })
            .parse(await send("Accessibility.queryAXTree", params))
          if (command.within.length)
            subtree.nodes = subtree.nodes.filter(
              (node) => node.backendDOMNodeId !== backendNodeId
            )
          return subtree
        }
        const [tree, metrics] = await Promise.all([
          readTree(),
          scoped
            ? Promise.resolve(null)
            : pageMetrics(binding.connection, binding.sessionId, signal).catch(
                () => null
              ),
        ])
        const result = z
          .object({ nodes: z.array(AccessibilityNodeSchema) })
          .parse(tree)
        // AX omits some empty values and may abbreviate others. Read the actual
        // matched control, using its backend identity, for exact assertions.
        if (command.match) {
          for (const node of result.nodes.slice(
            command.offset,
            command.offset + command.maxNodes
          )) {
            if (
              !node.backendDOMNodeId ||
              !["textbox", "searchbox", "combobox"].includes(
                String(node.role?.value)
              )
            )
              continue
            const response = await this.callOnBackendNode(
              binding,
              node.backendDOMNodeId,
              "function(){if(!this.isConnected)throw Error('Element detached: observe again');return typeof this.value==='string'?this.value:this.isContentEditable?this.textContent:null}",
              signal
            )
            const value = z
              .object({ result: z.object({ value: z.string().nullable() }) })
              .parse(response).result.value
            if (value !== null) node.value = { value }
          }
        }
        const observation = browserObservation({
          target: binding.target,
          info,
          nodes: result.nodes,
          maxNodes: command.maxNodes,
          offset: command.offset,
          query: command.query,
          interactiveOnly: command.interactiveOnly,
          exactValues: command.match !== undefined,
          viewport: metrics
            ? {
                ...metrics.cssVisualViewport,
                contentWidth: metrics.cssContentSize.width,
                contentHeight: metrics.cssContentSize.height,
              }
            : undefined,
        })
        if (binding.lineage !== lineage)
          fault(
            "stale-target",
            "The document changed during observation. Read this tab again."
          )
        const semanticNodes = observation.value.nodes.map((node) => {
          const semantic = { ...node }
          delete semantic.ref
          return semantic
        })
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              ...observation.value,
              nodes: semanticNodes,
            })
          )
          .digest("base64url")
        if (
          command.since !== undefined &&
          binding.observation?.token === command.since &&
          binding.observation.digest === digest
        ) {
          const nextNodeIds = [...observation.refs.values()]
          if (binding.observation.refs.length === nextNodeIds.length) {
            binding.refs = new Map(
              binding.observation.refs.map((ref, index) => [
                ref,
                z.number().parse(nextNodeIds[index]),
              ])
            )
            return {
              target: { ...binding.target },
              observation: binding.observation.token,
              lineage,
              unchanged: true,
            }
          }
        }
        const token = randomUUID()
        binding.refs = observation.refs
        binding.observation = {
          token,
          digest,
          refs: [...observation.refs.keys()],
        }
        return { ...observation.value, observation: token, lineage }
      }
      case "screenshot": {
        if (
          Number(command.fullPage) +
            Number(command.ref !== undefined) +
            Number(command.region !== undefined) >
          1
        )
          fault(
            "invalid-request",
            "Choose one screenshot scope: fullPage, ref, or region."
          )
        const box = command.ref
          ? await this.box(binding, command.ref, signal)
          : undefined
        const geometry = await screenshotGeometry(
          binding.connection,
          binding.sessionId,
          {
            fullPage: command.fullPage,
            maxSide: command.maxSide,
            box,
            region: command.region,
          },
          signal
        )
        const visible = geometry.viewport
        const area = geometry.clip
        const inViewport = !command.fullPage && area.x >= visible.pageX && area.y >= visible.pageY &&
          area.x + area.width <= visible.pageX + visible.clientWidth && area.y + area.height <= visible.pageY + visible.clientHeight
        const result = z
          .object({ data: z.string().max(24 * 1024 * 1024) })
          .parse(
            await (inViewport ? send("Page.captureScreenshot", {
              format: "png", optimizeForSpeed: true, captureBeyondViewport: false,
            }) : binding.capture.screenshot(() => send("Page.captureScreenshot", {
              format: command.format,
              ...(command.format === "jpeg"
                ? { quality: command.quality }
                : { optimizeForSpeed: true }),
              captureBeyondViewport:
                command.fullPage || Boolean(box || command.region),
              clip: geometry.clip,
            })))
          )
        if (inViewport) {
          // CDP clips resize Chromium's capture surface and can leak those pixels
          // into a concurrent screencast. Crop the returned full-view pixels instead.
          const pixels = Buffer.from(result.data, "base64")
          const size = imageSize(pixels)
          if (size.width * size.height > 16_000_000)
            fault("invalid-request", "The browser viewport exceeds the screenshot pixel budget.")
          const sx = size.width / geometry.captureWidth, sy = size.height / geometry.captureHeight
          if (Math.abs(size.width * geometry.captureHeight - size.height * geometry.captureWidth) > 2 * Math.max(size.width, size.height, geometry.captureWidth, geometry.captureHeight))
            fault("invalid-request", "The viewport changed during capture. Read its geometry again before using screenshot coordinates.")
          const left = Math.floor((area.x - visible.pageX) * sx), top = Math.floor((area.y - visible.pageY) * sy)
          const right = Math.min(size.width, Math.ceil((area.x + area.width - visible.pageX) * sx))
          const bottom = Math.min(size.height, Math.ceil((area.y + area.height - visible.pageY) * sy))
          let image = sharp(pixels, { limitInputPixels: 16_000_000 }).extract({ left, top, width: right - left, height: bottom - top }).resize({
            width: Math.max(1, Math.round(area.width * area.scale * geometry.devicePixelRatio)),
            height: Math.max(1, Math.round(area.height * area.scale * geometry.devicePixelRatio)),
            fit: "inside", withoutEnlargement: true,
          })
          image = command.format === "png" ? image.png() : image.jpeg({ quality: command.quality })
          result.data = (await image.toBuffer()).toString("base64")
          geometry.clip = { ...area, x: visible.pageX + left / sx, y: visible.pageY + top / sy, width: (right - left) / sx, height: (bottom - top) / sy }
        }
        const { width, height } = imageSize(Buffer.from(result.data, "base64"))
        const coordinates = {
          units: "CSS pixels",
          imageWidth: width,
          imageHeight: height,
          imageScaleX: width / geometry.clip.width,
          imageScaleY: height / geometry.clip.height,
          devicePixelRatio: geometry.devicePixelRatio,
          pageX: geometry.clip.x,
          pageY: geometry.clip.y,
          viewportPageX: geometry.viewport.pageX,
          viewportPageY: geometry.viewport.pageY,
          viewportWidth: geometry.viewport.clientWidth,
          viewportHeight: geometry.viewport.clientHeight,
          instruction:
            "For click coordinates: x = imageX / imageScaleX + pageX - viewportPageX; y = imageY / imageScaleY + pageY - viewportPageY. Use scroll to bring offscreen content into the viewport before clicking it.",
        }
        const view = randomUUID()
        binding.view = view
        return {
          target: { ...binding.target },
          view,
          coordinates,
          clip: geometry.clip,
          mimeType: command.format === "png" ? "image/png" : "image/jpeg",
          data: result.data,
        }
      }
      case "events": {
        const events: JsonObject[] = []
        let bytes = 0
        let more = false
        for (const event of binding.events) {
          if (event.cursor <= command.after) continue
          const entry: JsonObject = {
            cursor: event.cursor,
            method: event.method,
            params: event.params,
            sessionId: event.sessionId ?? null,
          }
          const size = Buffer.byteLength(JSON.stringify(entry)) + 1
          if (
            events.length >= command.limit ||
            bytes + size > OBSERVATION_BUDGET_BYTES
          ) {
            more = true
            break
          }
          bytes += size
          events.push(entry)
        }
        return {
          target: { ...binding.target },
          events,
          cursor:
            events.length > 0
              ? z.number().parse(events[events.length - 1].cursor)
              : command.after,
          more,
          gap:
            command.after > 0 &&
            binding.events.length === EVENT_ENTRY_LIMIT &&
            command.after < binding.events[0].cursor,
        }
      }
      case "evaluate": {
        const contextId = command.frameId
          ? await this.frameContext(binding, command.frameId, signal)
          : undefined
        const evaluation: JsonObject = {
          expression: command.expression,
          awaitPromise: true,
          returnByValue: true,
        }
        if (contextId !== undefined) evaluation.contextId = contextId
        const result = await send("Runtime.evaluate", evaluation)
        if (result.exceptionDetails)
          throw new BrowserFault({
            code: "protocol-error",
            message: JSON.stringify(result.exceptionDetails),
            outcome: "rejected",
          })
        return result
      }
      case "navigate":
        return navigatePage(
          binding.connection,
          binding.sessionId,
          pageUrl(command.url),
          signal,
          command.waitUntil ?? "load",
          command.timeoutMs
        )
      case "close": {
        binding.intentionalDetach = true
        const key = this.key(binding.target)
        const owned = this.ownedTargets.get(key)
        const result = owned?.browserContextId
          ? await root("Target.disposeBrowserContext", {
              browserContextId: owned.browserContextId,
            })
          : await root("Target.closeTarget", {
              targetId: binding.target.tab,
            })
        this.recordings.stopTarget(
          binding.owner,
          binding.target,
          "Tab lease ended"
        )
        this.endBinding(this.bindings.get(key), "Tab binding ended")
        this.bindings.delete(key)
        this.ownedTargets.delete(key)
        return result
      }
      case "release": {
        binding.intentionalDetach = true
        await binding.focus.close()
        const result = await root("Target.detachFromTarget", {
          sessionId: binding.sessionId,
        })
        this.recordings.stopTarget(
          binding.owner,
          binding.target,
          "Tab lease ended"
        )
        this.endBinding(binding, "Tab binding ended")
        this.bindings.delete(this.key(binding.target))
        return result
      }
      case "cdp": {
        if ((command.method.startsWith("Browser.") && command.method !== "Browser.getVersion") ||
            (command.method.startsWith("SystemInfo.") && !["SystemInfo.getInfo", "SystemInfo.getProcessInfo"].includes(command.method)) ||
            command.method.startsWith("Storage.") ||
            ["Network.setCookie", "Network.setCookies", "Network.deleteCookies", "Network.clearBrowserCookies", "Network.clearBrowserCache"].includes(command.method))
          fault("invalid-request", "This raw command changes browser/profile state outside the tab lease. Use cookies for profile cookie operations and managed open/release/close for target lifecycle. Browser-wide administration belongs to the owning supervisor.")
        if (command.method === "Emulation.setFocusEmulationEnabled")
          fault("invalid-request", "Focus emulation belongs to managed input and live capture; raw changes would interrupt other consumers of this tab.")
        if (["Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"].includes(command.method))
          fault("invalid-request", "Use tab.record() for capture; recording and live preview share this tab's stream.")
        if (command.method === "Page.captureScreenshot")
          return binding.capture.screenshot(() => send(command.method, command.params))
        // Target lifecycle stays in the owner so raw protocol calls cannot silently change its bindings.
        if (
          command.method.startsWith("Target.") &&
          ![
            "Target.getTargets",
            "Target.getTargetInfo",
            "Target.activateTarget",
          ].includes(command.method)
        )
          fault(
            "invalid-request",
            "Use open, select, release and close for target lifecycle. Other CDP domains are available through this exact session."
          )
        if (
          command.method === "Target.getTargetInfo" ||
          command.method === "Target.activateTarget"
        )
          return root(command.method, { targetId: binding.target.tab })
        if (command.method === "Page.navigate") {
          const url = z.string().safeParse(command.params.url)
          if (!url.success) fault("invalid-request", "Page.navigate needs url.")
          return send(command.method, {
            ...command.params,
            url: pageUrl(url.data),
          })
        }
        return command.method.startsWith("Target.") ||
          command.method.startsWith("Browser.") ||
          command.method.startsWith("SystemInfo.")
          ? root(command.method, command.params)
          : send(command.method, command.params)
      }
      case "type": {
        const field = command.ref
          ? await this.focusEditable(binding, command.ref, signal)
          : await this.activeEditable(binding, signal)
        if (command.clear && field.length > 0) {
          await this.keyPress(
            binding,
            { key: "a", code: "KeyA", keyCode: 65 },
            0,
            signal,
            ["selectAll"]
          )
        }
        // Selection replacement is one edit. Clearing first emits an intermediate
        // empty input event that controlled forms may reject or use to move focus.
        if (command.clear && field.length > 0 && command.text === "")
          await this.keyPress(binding, keySpec("Backspace"), 0, signal)
        else if (command.text !== "")
          await send("Input.insertText", { text: command.text })
        if (command.submit) await this.keyPress(binding, keySpec("Enter"), 0, signal)
        return {
          field: field.tag,
          cleared: command.clear && field.length > 0 ? field.length : 0,
          inserted: command.text.length,
          submitted: command.submit,
        }
      }
      case "press": {
        if (command.ref)
          await this.focusEditable(binding, command.ref, signal, false)
        await this.keyPress(
          binding,
          keySpec(command.key),
          modifierMask(command.modifiers),
          signal
        )
        return { key: command.key, modifiers: command.modifiers ?? [] }
      }
      case "upload": {
        if (!command.files.every(isAbsolute))
          fault(
            "invalid-request",
            "Upload paths must be explicit absolute local paths."
          )
        return send("DOM.setFileInputFiles", {
          backendNodeId: this.node(binding, command.ref),
          files: command.files,
        })
      }
      case "hover": {
        const point = await this.resolvePoint(binding, command.at, signal)
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button: "none",
          pointerType: "mouse",
        })
        return { ...point }
      }
      case "scroll": {
        const point = command.at
          ? await this.resolvePoint(binding, command.at, signal)
          : await this.viewportCentre(binding, signal)
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          ...point,
          deltaX: command.deltaX,
          deltaY: command.deltaY,
          pointerType: "mouse",
        })
        // Wheel scrolling is applied by the compositor and may animate; read
        // the position once it has moved and settled, or after 250 ms.
        const position = scrollResult.safeParse(
          await send("Runtime.evaluate", {
            expression:
              "(async()=>{const read=()=>({x:window.scrollX,y:window.scrollY});const sleep=ms=>new Promise(r=>setTimeout(r,ms));let last=read();let changed=false;const start=performance.now();for(;;){await sleep(16);const now=read();if(now.x!==last.x||now.y!==last.y){changed=true;last=now;continue}if(changed||performance.now()-start>250)return now}})()",
            awaitPromise: true,
            returnByValue: true,
          })
        )
        return {
          ...point,
          scrollX: position.success ? position.data.result.value.x : null,
          scrollY: position.success ? position.data.result.value.y : null,
        }
      }
      case "click":
        return this.clickAt(
          binding,
          command.at,
          command.button,
          command.count,
          modifierMask(command.modifiers),
          signal
        )
      case "dialog": {
        if (command.auto) binding.dialogPolicy = command.auto
        let answered: DialogState | null = null
        if (command.respond) {
          if (!binding.dialog)
            fault(
              "invalid-request",
              "No dialog is open on this tab. Read the pending dialog first, or set auto for future ones."
            )
          answered = binding.dialog
          const answer: JsonObject = { accept: command.respond === "accept" }
          if (command.promptText !== undefined)
            answer.promptText = command.promptText
          await send("Page.handleJavaScriptDialog", answer)
          // Answering may synchronously open another dialog. Do not erase its
          // state or restore focus while that new modal blocks the renderer.
          if (binding.dialog === answered) binding.dialog = null
          await binding.focus.setDialogOpen(binding.dialog !== null)
        }
        const describe = (dialog: DialogState): JsonObject => ({
          type: dialog.type,
          message: dialog.message,
          defaultPrompt: dialog.defaultPrompt ?? null,
          url: dialog.url ?? null,
          openedAt: dialog.openedAt,
        })
        return {
          pending: binding.dialog ? describe(binding.dialog) : null,
          answered: answered
            ? { ...describe(answered), respond: command.respond ?? null }
            : null,
          auto: binding.dialogPolicy,
        }
      }
      case "downloadStatus": {
        if (
          this.entry(binding.target.browser).definition.transport !==
          "extension"
        )
          fault(
            "unavailable",
            "Download IDs are available through the browser extension."
          )
        return this.exportDownload(
          binding,
          extensionDownloadSchema.parse(
            await send("Mako.downloadStatus", {
              id: command.id,
              timeoutMs: command.timeoutMs,
            })
          )
        )
      }
      case "download": {
        if (!isAbsolute(command.directory))
          fault("invalid-request", "directory must be an absolute local path.")
        const directory = await stat(command.directory).catch(() => null)
        if (!directory?.isDirectory())
          fault(
            "invalid-request",
            `${command.directory} is not an existing directory.`
          )
        if (!command.at && !command.url)
          fault("invalid-request", "Pass at (an element to click) or url.")
        if (
          this.entry(binding.target.browser).definition.transport ===
          "extension"
        ) {
          if (!command.url || command.at)
            fault(
              "invalid-request",
              "Extension downloads require an explicit http(s) URL. No click was dispatched. Page-triggered downloads can be inspected in the browser; their IDs cannot safely be inferred from a filename."
            )
          const result = extensionDownloadSchema.parse(
            await send("Mako.download", {
              url: command.url,
              timeoutMs: command.timeoutMs,
            })
          )
          if (binding.downloadExports.size >= 128) {
            const completed = [...binding.downloadExports].find(
              ([, entry]) => entry.path
            )
            if (completed) binding.downloadExports.delete(completed[0])
          }
          binding.downloadExports.set(result.id, {
            directory: command.directory,
          })
          return this.exportDownload(binding, result)
        }
        const known = new Set(binding.downloads.keys())
        await send("Page.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: command.directory,
        })
        if (command.at)
          await this.clickAt(binding, command.at, "left", 1, 0, signal)
        else if (command.url) {
          const url = pageUrl(command.url)
          if (!url.startsWith("http"))
            fault("invalid-request", "url must be http or https.")
          await send("Page.navigate", { url })
        }
        const deadline = Date.now() + command.timeoutMs
        let download: DownloadState | undefined
        while (Date.now() < deadline) {
          signal.throwIfAborted()
          download = [...binding.downloads.values()].find(
            (entry) => !known.has(entry.guid)
          )
          if (download && download.state !== "inProgress") break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!download)
          throw new BrowserFault({
            code: "timed-out",
            message: `No download started within ${command.timeoutMs} ms. The click or URL may not trigger a file download; observe the tab.`,
            outcome: "unknown",
          })
        const path = download.suggestedFilename
          ? join(command.directory, download.suggestedFilename)
          : null
        const saved = path ? await stat(path).catch(() => null) : null
        return {
          guid: download.guid,
          state: download.state,
          url: download.url ?? null,
          suggestedFilename: download.suggestedFilename ?? null,
          path,
          bytes: saved?.size ?? download.receivedBytes ?? null,
          note:
            download.state === "completed"
              ? saved
                ? null
                : "The browser reported completion but the file is not at the suggested path; the browser may have renamed it to avoid a clash. List the directory."
              : download.state === "canceled"
                ? "The download was cancelled."
                : `The download was still in progress after ${command.timeoutMs} ms.`,
        }
      }
      case "pdf": {
        if (!isAbsolute(command.path))
          fault("invalid-request", "path must be an absolute local file path.")
        const parent = await stat(dirname(command.path)).catch(() => null)
        if (!parent?.isDirectory())
          fault(
            "invalid-request",
            `${dirname(command.path)} is not an existing directory.`
          )
        const print: JsonObject = {
          landscape: command.landscape,
          printBackground: command.printBackground,
          scale: command.scale,
        }
        if (command.paperWidth !== undefined)
          print.paperWidth = command.paperWidth
        if (command.paperHeight !== undefined)
          print.paperHeight = command.paperHeight
        if (command.pageRanges !== undefined)
          print.pageRanges = command.pageRanges
        const result = pdfResult.parse(await send("Page.printToPDF", print))
        const bytes = Buffer.from(result.data, "base64")
        await writeFile(command.path, bytes)
        return { path: command.path, bytes: bytes.byteLength }
      }
      case "cookies": {
        switch (command.operation) {
          case "list": {
            const info = await root("Target.getTargetInfo", {
              targetId: binding.target.tab,
            })
            const current = z
              .object({ targetInfo: z.object({ url: z.string() }) })
              .parse(info).targetInfo.url
            const listed = cookieList.parse(
              await send("Network.getCookies", {
                urls: command.urls ?? [current],
              })
            )
            return {
              cookies: listed.cookies.map((cookie) => ({
                name: cookie.name,
                domain: cookie.domain,
                path: cookie.path,
                expires: cookie.expires ?? null,
                secure: cookie.secure ?? false,
                httpOnly: cookie.httpOnly ?? false,
                sameSite: cookie.sameSite ?? null,
                ...(command.includeValues
                  ? { value: cookie.value }
                  : { valueLength: cookie.value.length }),
              })),
            }
          }
          case "set": {
            if (!command.cookies?.length)
              fault("invalid-request", "cookies is required for set.")
            for (const cookie of command.cookies)
              if (!cookie.url && !cookie.domain)
                fault(
                  "invalid-request",
                  `Cookie ${cookie.name} needs url or domain.`
                )
            await send("Network.setCookies", { cookies: command.cookies })
            return { set: command.cookies.map((cookie) => cookie.name) }
          }
          case "delete": {
            if (!command.name)
              fault("invalid-request", "name is required for delete.")
            const removal: JsonObject = { name: command.name }
            if (command.url !== undefined) removal.url = command.url
            if (command.domain !== undefined) removal.domain = command.domain
            if (command.path !== undefined) removal.path = command.path
            await send("Network.deleteCookies", removal)
            return { deleted: command.name }
          }
          case "clear":
            await send("Network.clearBrowserCookies")
            return { cleared: true }
          default:
            return fault("invalid-request", "Unknown cookie operation.")
        }
      }
      case "frames": {
        const tree = await send("Page.getFrameTree")
        const frames: JsonObject[] = []
        const walk = (value: JsonValue, depth: number) => {
          const node = frameNode.safeParse(value)
          if (!node.success) return
          frames.push({
            id: node.data.frame.id,
            parentId: node.data.frame.parentId ?? null,
            url: node.data.frame.url,
            name: node.data.frame.name ?? null,
            origin: node.data.frame.securityOrigin ?? null,
            depth,
          })
          for (const child of node.data.childFrames ?? [])
            walk(child, depth + 1)
        }
        walk(tree.frameTree, 0)
        return {
          frames,
          note: "Same-process frames accept frameId on observe and evaluate. Out-of-process iframes appear as separate iframe targets in tabs.",
        }
      }
      case "wait": {
        const started = Date.now()
        const deadline = started + command.timeoutMs
        if (command.for.networkIdle && !binding.network.enabled) {
          await send("Network.enable")
          binding.network.enabled = true
        }
        const conditions = command.for
        const domCondition =
          conditions.selector !== undefined || conditions.text !== undefined
        for (;;) {
          signal.throwIfAborted()
          const remaining = deadline - Date.now()
          if (remaining <= 0)
            return { satisfied: false, elapsedMs: Date.now() - started }
          let dom = true
          if (domCondition) {
            const slice = Math.min(remaining, WAIT_SLICE_MS)
            const result = waitResult.parse(
              await send("Runtime.evaluate", {
                expression: `(async()=>{const deadline=performance.now()+${slice};const wantSelector=${JSON.stringify(conditions.selector ?? null)};const wantText=${JSON.stringify(conditions.text ?? null)};const hidden=${conditions.hidden};const check=()=>{const s=wantSelector===null?true:(!!document.querySelector(wantSelector))!==hidden;const t=wantText===null?true:(!!document.body&&document.body.innerText.includes(wantText))!==hidden;return s&&t};for(;;){if(check())return true;if(performance.now()>deadline)return false;await new Promise(r=>setTimeout(r,100))}})()`,
                awaitPromise: true,
                returnByValue: true,
              })
            )
            dom = result.result.value
            if (!dom) continue
          }
          let url = true
          if (conditions.url !== undefined) {
            const info = await root("Target.getTargetInfo", {
              targetId: binding.target.tab,
            })
            url = z
              .object({ targetInfo: z.object({ url: z.string() }) })
              .parse(info)
              .targetInfo.url.includes(conditions.url)
          }
          let idle = true
          if (conditions.networkIdle) {
            idle = binding.network.inflight.size === 0
            if (idle) {
              await new Promise((resolve) => setTimeout(resolve, 500))
              idle = binding.network.inflight.size === 0
            }
          }
          if (dom && url && idle)
            return { satisfied: true, elapsedMs: Date.now() - started }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      case "history": {
        const loaded = this.awaitLoad(binding, signal)
        if (command.go === "reload") await send("Page.reload", {})
        else {
          const history = historyResult.parse(
            await send("Page.getNavigationHistory")
          )
          const index = history.currentIndex + (command.go === "back" ? -1 : 1)
          const entry = history.entries[index]
          if (!entry) {
            loaded.cancel()
            return {
              moved: false,
              url: history.entries[history.currentIndex]?.url ?? null,
            }
          }
          await send("Page.navigateToHistoryEntry", { entryId: entry.id })
        }
        const completion = await loaded.promise
        const after = historyResult.parse(
          await send("Page.getNavigationHistory")
        )
        return {
          moved: true,
          completion,
          url: after.entries[after.currentIndex]?.url ?? null,
        }
      }
      case "selectOption": {
        if (command.value === undefined && command.label === undefined)
          fault("invalid-request", "Pass value or label.")
        const result = await this.callOnNode(
          binding,
          command.ref,
          `function(){if(!this.isConnected)throw Error('Element detached: observe again');if(this.tagName!=='SELECT')throw Error('Element <'+this.tagName.toLowerCase()+'> is not a <select>; use click or type instead');const want=${JSON.stringify(command.value ?? null)};const label=${JSON.stringify(command.label ?? null)};const option=[...this.options].find(o=>want!==null?o.value===want:o.label.trim()===label.trim());if(!option)throw Error('No option matches; options are: '+[...this.options].map(o=>o.label.trim()+'='+o.value).slice(0,50).join(', '));this.value=option.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {value:option.value,label:option.label.trim()}}`,
          signal
        )
        return z
          .object({
            result: z.object({
              value: z.object({ value: z.string(), label: z.string() }),
            }),
          })
          .parse(result).result.value
      }
    }
  }

  /** A modal can suspend a renderer's input acknowledgement until answered.
   * Stop waiting on the event, but never treat that event as input success. */
  private async input(
    binding: Binding,
    method: string,
    params: JsonObject,
    signal: AbortSignal
  ): Promise<JsonObject> {
    const interrupted = new AbortController()
    let dialog: DialogState | null = null
    const opened = () => {
      if (binding.dialogPolicy !== "ask" || !binding.dialog) return
      dialog = binding.dialog
      interrupted.abort()
    }
    const unsubscribe = binding.connection.onEvent((event) => {
      if (event.sessionId === binding.sessionId &&
          event.method === "Page.javascriptDialogOpening") opened()
    })
    try {
      // Dispatch before checking an already open dialog: this permits the one
      // button/key release that cleans up an interrupted press. The normal
      // command boundary refuses new input while a dialog is open.
      const pending = binding.connection.send(
        method, params, AbortSignal.any([signal, interrupted.signal]), binding.sessionId
      )
      opened()
      try {
        return await pending
      } catch (error) {
        if (dialog && !signal.aborted && error instanceof BrowserFault &&
            error.detail.code === "cancelled" && error.detail.outcome === "unknown")
          throw new BrowserFault({
            code: "dialog-open",
            message: "A dialog interrupted input acknowledgement. The input may already have taken effect; do not repeat it. Read dialog({}), answer with dialog({respond:'accept'|'dismiss'}), then observe this exact tab before more input.",
            outcome: "unknown",
          })
        throw error
      }
    } finally {
      unsubscribe()
    }
  }

  private async clickAt(
    binding: Binding,
    at: { ref: string } | { x: number; y: number },
    button: "left" | "right" | "middle",
    count: number,
    modifiers: number,
    signal: AbortSignal
  ): Promise<JsonValue> {
    const send = (method: string, params: JsonObject = {}) =>
      this.input(binding, method, params, signal)
    const point = await this.resolvePoint(binding, at, signal)
    const pressed = {
      ...point,
      button,
      clickCount: count,
      modifiers,
      pointerType: "mouse",
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
      button: "none",
      modifiers,
      pointerType: "mouse",
    })
    const release = (timeoutMs: number) =>
      this.input(
        binding,
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", ...pressed, buttons: 0 },
        AbortSignal.timeout(timeoutMs)
      )
    try {
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...pressed,
        buttons: BUTTON_BITS[button],
      })
    } catch (error) {
      if (error instanceof BrowserFault && error.detail.outcome === "unknown")
        await release(2000).catch(() => {})
      throw error
    }
    // Release once with its own budget, even when the caller cancelled after
    // press. A missing acknowledgement is never permission to replay release.
    const released = await release(5000)
    if (signal.aborted)
      throw new BrowserFault({
        code: "cancelled",
        message:
          "Click was dispatched and its button released before cancellation. Observe before deciding whether to click again.",
        outcome: "unknown",
      })
    return released
  }

  /** An execution context inside one same-process frame. */
  private async frameContext(
    binding: Binding,
    frameId: string,
    signal: AbortSignal
  ): Promise<number> {
    const world = await binding.connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "mako", grantUniveralAccess: true },
      signal,
      binding.sessionId
    )
    return isolatedWorld.parse(world).executionContextId
  }

  /** Resolve once this session's main frame reports load, or after ten seconds. */
  private awaitLoad(binding: Binding, signal: AbortSignal) {
    let settle: ((value: "load" | "timeout") => void) | undefined
    const timer = setTimeout(() => settle?.("timeout"), 10_000)
    const unsubscribe = binding.connection.onEvent((event) => {
      if (
        event.sessionId === binding.sessionId &&
        event.method === "Page.lifecycleEvent" &&
        event.params.name === "load"
      )
        settle?.("load")
    })
    const abort = () => settle?.("timeout")
    signal.addEventListener("abort", abort, { once: true })
    const promise = new Promise<"load" | "timeout">((resolve) => {
      settle = (value) => {
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener("abort", abort)
        settle = undefined
        resolve(value)
      }
    })
    return { promise, cancel: () => settle?.("timeout") }
  }

  private async keyPress(
    binding: Binding,
    spec: KeySpec,
    modifiers: number,
    signal: AbortSignal,
    commands?: string[]
  ): Promise<void> {
    const down: JsonObject = {
      type: spec.text === undefined || commands ? "rawKeyDown" : "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    }
    if (spec.text !== undefined && !commands) {
      down.text = spec.text
      down.unmodifiedText = spec.text
    }
    if (commands) down.commands = commands
    const release = () => this.input(binding, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    }, AbortSignal.timeout(5000))
    try {
      await this.input(binding, "Input.dispatchKeyEvent", down, signal)
    } catch (error) {
      if (error instanceof BrowserFault && error.detail.outcome === "unknown")
        await release().catch(() => {})
      throw error
    }
    await release()
    if (signal.aborted)
      throw new BrowserFault({
        code: "cancelled",
        message: "Key input was dispatched and released before cancellation. Observe before deciding whether to press again.",
        outcome: "unknown",
      })
  }

  private node(binding: Binding, ref: string): number {
    const id = binding.refs.get(ref)
    if (id === undefined)
      fault(
        "stale-target",
        `Ref "${ref}" is not from this tab's latest observation. Observe the exact tab again and use a ref from that result.`
      )
    return id
  }

  private callOnNode(
    binding: Binding,
    ref: string,
    functionDeclaration: string,
    signal: AbortSignal
  ): Promise<JsonObject> {
    return this.callOnBackendNode(
      binding,
      this.node(binding, ref),
      functionDeclaration,
      signal
    )
  }

  private async callOnBackendNode(
    binding: Binding,
    backendNodeId: number,
    functionDeclaration: string,
    signal: AbortSignal
  ): Promise<JsonObject> {
    let node: JsonObject
    try {
      node = await binding.connection.send(
        "DOM.resolveNode",
        {
          backendNodeId,
        },
        signal,
        binding.sessionId
      )
    } catch (error) {
      if (
        error instanceof BrowserFault &&
        error.detail.code === "protocol-error"
      )
        fault(
          "stale-target",
          `Backend node ${backendNodeId} no longer resolves to an element; the page changed. Observe the exact tab again.`
        )
      throw error
    }
    const {
      object: { objectId },
    } = z.object({ object: z.object({ objectId: z.string() }) }).parse(node)
    const result = await binding.connection.send(
      "Runtime.callFunctionOn",
      { objectId, returnByValue: true, functionDeclaration },
      signal,
      binding.sessionId
    )
    const failure = z
      .object({
        exceptionDetails: z.object({
          exception: z
            .object({ description: z.string().optional() })
            .optional(),
          text: z.string().optional(),
        }),
      })
      .safeParse(result)
    if (failure.success)
      fault(
        "invalid-request",
        failure.data.exceptionDetails.exception?.description?.split("\n")[0] ??
          failure.data.exceptionDetails.text ??
          "The element could not be used."
      )
    return result
  }

  private async point(
    binding: Binding,
    ref: string,
    signal: AbortSignal
  ): Promise<{ x: number; y: number }> {
    const result = await this.callOnNode(
      binding,
      ref,
      "function(){if(!this.isConnected)throw Error('Element detached: observe again');this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=this.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=this.getRootNode().elementFromPoint(x,y);if(!r.width||!r.height||!(hit===this||this.contains(hit)||(hit&&hit.contains(this))))throw Error('Element is hidden or covered at its centre; observe again or use coordinates from a screenshot');return {x,y}}",
      signal
    )
    return pointResult.parse(result).result.value
  }

  private async box(
    binding: Binding,
    ref: string,
    signal: AbortSignal
  ): Promise<ElementBox> {
    const result = await this.callOnNode(
      binding,
      ref,
      "function(){if(!this.isConnected)throw Error('Element detached: observe again');this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=this.getBoundingClientRect();if(!r.width||!r.height)throw Error('Element has no box');const m=8;return {x:Math.max(0,r.x+window.scrollX-m),y:Math.max(0,r.y+window.scrollY-m),width:r.width+2*m,height:r.height+2*m}}",
      signal
    )
    return boxResult.parse(result).result.value
  }

  private async focusEditable(
    binding: Binding,
    ref: string,
    signal: AbortSignal,
    requireEditable = true
  ): Promise<{ tag: string; length: number }> {
    const result = await this.callOnNode(
      binding,
      ref,
      `function(){if(!this.isConnected)throw Error('Element detached: observe again');const tag=this.tagName.toLowerCase();const editable=this.isContentEditable||((tag==='input'||tag==='textarea')&&!this.disabled&&!this.readOnly)||tag==='select';if(${requireEditable}&&!editable)throw Error('Element <'+tag+'> is not editable; choose a text field, textarea, select or contenteditable ref');this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});this.focus();const active=this.getRootNode().activeElement;if(active!==this&&!this.contains(active))throw Error('Element <'+tag+'> did not take focus; click it first or use coordinates');return {tag,length:String(this.value??this.textContent??'').length}}`,
      signal
    )
    return editableResult.parse(result).result.value
  }

  private async activeEditable(
    binding: Binding,
    signal: AbortSignal
  ): Promise<{ tag: string; length: number }> {
    const result = await binding.connection.send(
      "Runtime.evaluate",
      {
        expression:
          "(()=>{let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;if(!a||a===document.body)return null;const tag=a.tagName.toLowerCase();const editable=a.isContentEditable||((tag==='input'||tag==='textarea')&&!a.disabled&&!a.readOnly)||tag==='select';return editable?{tag,length:String(a.value??a.textContent??'').length}:{tag,length:-1}})()",
        returnByValue: true,
      },
      signal,
      binding.sessionId
    )
    const active = z
      .object({
        result: z.object({
          value: z.object({ tag: z.string(), length: z.number() }).nullable(),
        }),
      })
      .parse(result).result.value
    if (!active || active.length < 0)
      fault(
        "invalid-request",
        active
          ? `The focused element <${active.tag}> is not editable. Pass the ref of a text field, or click it first.`
          : "No element has focus in this tab. Pass the ref of a text field, or click it first."
      )
    return active
  }

  private resolvePoint(
    binding: Binding,
    at: { ref: string } | { x: number; y: number },
    signal: AbortSignal
  ): Promise<{ x: number; y: number }> {
    return "ref" in at
      ? this.point(binding, at.ref, signal)
      : Promise.resolve({ x: at.x, y: at.y })
  }

  private async viewportCentre(
    binding: Binding,
    signal: AbortSignal
  ): Promise<{ x: number; y: number }> {
    const metrics = await pageMetrics(
      binding.connection,
      binding.sessionId,
      signal
    )
    return {
      x: metrics.cssVisualViewport.clientWidth / 2,
      y: metrics.cssVisualViewport.clientHeight / 2,
    }
  }

  private async exportDownload(
    binding: Binding,
    result: z.infer<typeof extensionDownloadSchema>
  ): Promise<JsonValue> {
    const destination = binding.downloadExports.get(result.id)
    if (result.state !== "completed" || !result.path)
      return {
        ...result,
        note: "Use downloadStatus(id) to inspect this download; do not start it again.",
      }
    if (!destination) return result
    if (destination.path)
      return { ...result, path: destination.path, browserPath: result.path }
    const original = await stat(result.path)
    if (!original.isFile())
      fault(
        "unavailable",
        "The browser's completed download is not a regular file."
      )
    const folder = await mkdtemp(join(destination.directory, "mako-download-"))
    const path = join(folder, basename(result.path))
    await copyFile(result.path, path)
    destination.path = path
    return { ...result, path, browserPath: result.path, bytes: original.size }
  }

  /** End one task's leases and close every task-lifetime target it created. */
  async releaseOwner(owner: string, options: { finalizeRecordings?: boolean } = {}): Promise<{
    released: number
    closed: number
  }> {
    this.recordings.stopOwner(owner)
    if (options.finalizeRecordings) await this.recordings.finishOwner(owner)
    let released = 0
    let closed = 0
    const bindings = [...this.bindings.values()].filter(
      (binding) => binding.owner === owner
    )
    for (const binding of bindings) {
      await binding.tail
      const key = this.key(binding.target)
      if (this.bindings.get(key) !== binding) continue
      const signal = AbortSignal.timeout(2000)
      await binding.focus.close().catch(() => {})
      binding.intentionalDetach = true
      await binding.connection
        .send(
          "Target.detachFromTarget",
          { sessionId: binding.sessionId },
          signal
        )
        .catch(() => {})
      this.recordings.stopTarget(
        binding.owner,
        binding.target,
        "Tab lease ended"
      )
      this.endBinding(this.bindings.get(key), "Tab binding ended")
      this.bindings.delete(key)
      released++
    }
    const targets = [...this.ownedTargets.entries()].filter(
      ([, target]) => target.owner === owner
    )
    for (const [key, target] of targets) {
      this.ownedTargets.delete(key)
      const didClose = await target.connection
        .send(
          target.browserContextId
            ? "Target.disposeBrowserContext"
            : "Target.closeTarget",
          target.browserContextId
            ? { browserContextId: target.browserContextId }
            : { targetId: target.tab },
          AbortSignal.timeout(2000)
        )
        .then(
          () => true,
          () => false
        )
      if (didClose) closed++
    }
    for (const [id, attachedOwner] of this.attachmentOwners) {
      if (attachedOwner !== owner) continue
      this.disconnect(id)
      this.attached.delete(id)
      this.attachmentOwners.delete(id)
      this.uncertainProfiles.delete(id)
      this.browsers.delete(id)
      this.changed()
    }
    return { released, closed }
  }

  disconnect(id: string): void {
    const entry = this.entry(id)
    const connection = entry.connection
    entry.connectAbort?.abort()
    entry.connectAbort = undefined
    entry.connecting = undefined
    entry.connection = undefined
    entry.status = { ...entry.status, connection: { status: "disconnected" } }
    for (const [key, binding] of this.bindings)
      if (binding.target.browser === id) {
        this.recordings.stopTarget(
          binding.owner,
          binding.target,
          "Tab lease ended"
        )
        this.endBinding(this.bindings.get(key), "Tab binding ended")
        this.bindings.delete(key)
      }
    for (const [key, target] of this.ownedTargets)
      if (target.browser === id) this.ownedTargets.delete(key)
    connection?.close()
    this.changed()
  }
  close(): void {
    this.closing = true
    for (const id of this.browsers.keys()) this.disconnect(id)
    for (const binding of this.bindings.values()) this.endBinding(binding, "Browser service closed")
    this.bindings.clear()
    this.attachmentOwners.clear()
    this.attached.clear()
    this.profileMutations.clear()
    this.uncertainProfiles.clear()
    this.browserOperations.clear()
  }
}
