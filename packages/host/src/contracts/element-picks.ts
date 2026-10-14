import type { ElementPick, ElementPickEnd } from "@mako/control-runtime/contracts"

export type { ElementPick, ElementPickEnd, PickedElement } from "@mako/control-runtime/contracts"

/**
 * Picking an element in a browser tab for the composer: the tabs Mako can
 * reach, a pick started in one of them, and its outcome. The person points
 * in the page itself, so a pick lives on the host for as long as they take;
 * the client starts it, waits on it in slices and may cancel it.
 */

/** A tab by its browser and target id, as `mako:element-pick-targets` lists it. */
export interface ElementPickTarget {
  browser: string
  tab: string
}

export interface ElementPickTab extends ElementPickTarget {
  title: string
  url: string
  /** An agent holds this tab; the pick rides its session and the agent's input waits. */
  inUse: boolean
}

/** A browser the picker could reach, and whether it can now. */
export interface ElementPickBrowser {
  id: string
  name: string
  /** An image the desk can show as the browser's mark. */
  icon?: string
  kind: "browser" | "app"
  status: "connected" | "connecting" | "disconnected" | "setup-required" | "unavailable"
  reason?: string
}

export interface ElementPickTargets {
  browsers: ElementPickBrowser[]
  tabs: ElementPickTab[]
}

/** A pick to start, under an id the client minted: in a tab, or in the tab a conversation's agent shows. */
export type ElementPickRequest =
  | { id: string; target: ElementPickTarget }
  | { id: string; conversation: string }

export type ElementPickState =
  | { status: "picking"; title: string; url: string }
  | { status: "picked"; pick: ElementPick }
  | { status: "cancelled"; by: ElementPickEnd; reason: string }

/** The longest one `mako:element-pick-wait` holds the call open. */
export const ELEMENT_PICK_WAIT_MS = 25_000
