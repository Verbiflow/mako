import type { HarnessBehind } from "@mako/host/contracts/cloud-harnesses"
import { ownerName } from "./restore-plan"

/**
 * What the window says when a Thread's harnesses here are older than the cloud's (`ThreadHarnessCheck.behind`),
 * before it moves (`way: "move"`) or as it's brought back (`"back"`). The host weighs; these are only the words, kept
 * React-free so they can be checked without a renderer.
 */
export interface BehindWords {
  title: string
  /** What it means for the Thread, under the title. */
  detail: string
  /** One per harness: its versions, and what the person does when Mako can't update it. */
  rows: Array<{ harness: string; versions: string; todo?: string }>
  /** The one choice that updates what Mako can and goes on; absent when Mako can update none of them. */
  update?: string
  /** Going on without updating. */
  anyway: string
}

function listed(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "")
}

/** What the person does for a harness Mako can't update itself. */
function todo(behind: HarnessBehind, label: string): string | undefined {
  const offer = behind.offer
  if (offer.kind === "update") return undefined
  if (offer.kind === "owner" && offer.owner === "Mako") return `A newer Mako brings ${label} ${behind.cloud}: update Mako first.`
  if (offer.kind === "owner") return `Update it through ${ownerName(label, offer.owner)}; Mako checks again when you come back to this window.`
  return offer.command ? `Update it from a terminal: ${offer.command}` : `Update it to ${behind.cloud} or newer; Mako checks again when you come back to this window.`
}

export function behindWords(behind: readonly HarnessBehind[], label: (harness: string) => string, way: "move" | "back", handOff = false): BehindWords {
  const names = behind.map((each) => label(each.harness))
  const updating = behind.filter((each) => each.offer.kind === "update")
  // One harness is named with the version it gets: "Update Codex to 0.164.0, then move".
  const updatable = updating.length === 1 && updating[0]?.to ? [`${label(updating[0].harness)} to ${updating[0].to}`] : updating.map((each) => label(each.harness))
  const [one] = behind
  const title = behind.length === 1 ? `${names[0]} here is older than the cloud's` : "Harnesses here are older than the cloud's"
  const needs = behind.length === 1 && one ? `${names[0]} here is ${one.cloud} or newer` : `${listed(names)} here are as new as the cloud's`
  const detail = way === "move" ? `Once it works in the cloud, it comes back only after ${needs}.` : `It comes back once ${needs}.`
  const rows = behind.map((each) => {
    const name = label(each.harness)
    const help = todo(each, name)
    return { harness: each.harness, versions: `${name} ${each.here} here, ${each.cloud} in the cloud`, ...help && { todo: help } }
  })
  const then = way === "back" ? "then bring it back" : handOff ? "then hand off" : "then move"
  const update = updatable.length ? `Update ${listed(updatable)}, ${then}` : undefined
  const anyway = way === "back" ? "Bring back anyway" : handOff ? "Hand off anyway" : "Move anyway"
  return { title, detail, rows, ...update && { update }, anyway }
}
