/**
 * Setting simulators up on this Mac, from nothing to a simulator agents can drive, as one line (`mako:simulator-setup`,
 * and the `simulator-setup` event as it changes). Every step is read from what owns it (Xcode's own tools, the folders
 * it installs into, Mako's tool folder and the consent file), so the line resumes after a quit and says the same as
 * Xcode would. Mako does each step it can; the ones only the person can do (their Apple ID, their password) are said
 * plainly and use macOS's own prompts.
 */

/** In the order a person meets them. */
export const SETUP_STEPS = ["xcode", "finish", "runtime", "simulators", "tools", "agents", "try"] as const
export type SetupStepId = (typeof SETUP_STEPS)[number]

/**
 * The same words as turning the cloud on: `done`; `working`, going by itself; `yours`, waiting on the person;
 * `stuck`, held by a problem whose fix is said; `later`, not reached because a step before it isn't done.
 */
export type SetupStepState = "done" | "working" | "yours" | "stuck" | "later"

/** What the window offers beside a step: each is one press. */
export type SetupFix =
  /** Xcode's page in the App Store, for the person's Apple ID. */
  | "get-xcode"
  /** Point the active developer folder at Xcode, accept its license and run its first launch, in one macOS password prompt. */
  | "finish-xcode"
  /** Download the iOS simulator runtime this Xcode wants (`xcodebuild -downloadPlatform iOS`). */
  | "download-runtime"
  /** Make the iPhone and iPad simulators Mako's suite and agents use. */
  | "create-simulators"
  /** Install the pinned tools that stream, drive and read a simulator. */
  | "install-tools"
  /** Let agents in a project use simulators. */
  | "allow-agents"
  /** Boot the iPhone, open Mako's web app in Safari, and stream it here. */
  | "try"

/** An Xcode on this Mac, read from its bundle. */
export interface XcodeFound {
  /** `/Applications/Xcode.app`. */
  path: string
  /** `26.1`. */
  version: string
  /** `17B55`. */
  build?: string
}

/** A simulator runtime as `simctl list runtimes` says it. */
export interface RuntimeFound {
  /** `com.apple.CoreSimulator.SimRuntime.iOS-26-1`. */
  identifier: string
  /** `iOS 26.1`. */
  name: string
  version: string
  build?: string
  available: boolean
}

/** The two forms the suite and agents use. */
export type SetupForm = "phone" | "tablet"

/** One of Mako's own simulators: made by Mako, named for it, so the person's own are never changed. */
export interface SetupSimulator {
  form: SetupForm
  /** `Mako iPhone 17 Pro`. */
  name: string
  /** The device type it is, `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  type: string
  /** Its UDID, once made. */
  udid?: string
  runtime?: string
  state?: "shutdown" | "booted" | "booting" | "shutting-down"
}

/** A tool Mako installs for simulators, at the version it was checked with. */
export interface SetupTool {
  name: string
  /** The version Mako pins. */
  version: string
  /** What it does for Mako, in a few words. */
  purpose: string
  license: string
  /** The version installed in Mako's tool folder, when one is complete. */
  installed?: string
}

/** Agents' use of simulators in one project, as the person set it. */
export interface SetupConsent {
  folder: string
  allowed: boolean
  /** When the person last set it (ms). */
  at: number
}

/** Something under way that reports as it goes. */
export interface SetupProgress {
  step: SetupStepId
  /** 0 to 1, when the tool says. */
  fraction?: number
  doneBytes?: number
  totalBytes?: number
  /** The tool's own last line, as it said it. */
  line?: string
  startedAt: number
}

type Step<Id extends SetupStepId, Detail> = {
  id: Id
  state: SetupStepState
  /** Why it's stuck or what the person does, in words, beside the fix the window offers. */
  problem?: string
  fix?: SetupFix
} & Detail

export type SetupStep =
  | Step<"xcode", { xcode?: XcodeFound; developerDir?: string; disk: { freeBytes: number; needBytes: number } }>
  /** Each of the three checks Xcode's first run needs: the active developer folder, the license and first launch. */
  | Step<"finish", { selected: boolean; license: CheckState; firstLaunch: CheckState }>
  | Step<"runtime", { runtime?: RuntimeFound; wanted?: string }>
  | Step<"simulators", { simulators: SetupSimulator[] }>
  | Step<"tools", { tools: SetupTool[] }>
  | Step<"agents", { projects: SetupConsent[] }>
  | Step<"try", { firstFrameMs?: number; at?: number }>

/** `unknown` when the question couldn't be asked, as before Xcode is there. */
export type CheckState = "done" | "needed" | "unknown"

/**
 * `unavailable` off macOS; `setting-up` until every step a simulator needs is done; `ready` once one can run and be
 * driven; `broken` once it was ready and something it needs went (an Xcode update wanting its license again, a
 * runtime removed, a tool's folder gone), with the step that broke first saying how to repair it.
 */
export type SimulatorSetupPhase = "unavailable" | "setting-up" | "ready" | "broken"

export interface SimulatorSetup {
  phase: SimulatorSetupPhase
  /** When the facts were read (ms). */
  checkedAt: number
  /** `macOS 26.6.2, arm64`. */
  mac: string
  steps: SetupStep[]
  /** What's under way now, with its progress. */
  progress?: SetupProgress
  /** Why the last press failed, in the tool's words, until the next one. */
  failure?: { fix: SetupFix; message: string; at: number }
}

export type SetupStepOf<Id extends SetupStepId> = Extract<SetupStep, { id: Id }>

export function setupStep<Id extends SetupStepId>(setup: SimulatorSetup | undefined, id: Id): SetupStepOf<Id> | undefined {
  return setup?.steps.find((step): step is SetupStepOf<Id> => step.id === id)
}

/** The steps a simulator needs before agents can use it; agent access and the try come after. */
export const NEEDED_STEPS: readonly SetupStepId[] = ["xcode", "finish", "runtime", "simulators", "tools"]

/** Xcode's page in the Mac App Store, where the person signs in with their Apple ID. */
export const XCODE_APP_STORE_URL = "macappstore://apps.apple.com/app/xcode/id497799835"
