import { useEffect } from "react"
import { listedThreadItems, type SettingsEntry } from "@/components/palette/palette-sources"
import type { PaletteItem } from "@/components/palette/palette-search"
import { webHarnessLabel } from "./labels"
import { CLOUD_WHERE, type WebThread } from "./threads"

/** How the surface on screen opens a Thread (`useThreadOpener`): the desk's route, or the list's. */
let opener: ((thread: WebThread) => void) | undefined

/** The surface that draws the palette says how a row of it opens, kept current without rebuilding the rows. */
export function useThreadOpener(open: (thread: WebThread) => void): void {
  useEffect(() => {
    opener = open
    return () => {
      if (opener === open) opener = undefined
    }
  })
}

/**
 * The account's Threads as the palette's rows, on every form the web draws it: the laptop's desk and the phone's and
 * iPad's list. Each is found by its title, project, agents and where it runs, and opens as `useThreadOpener` says.
 */
export function paletteThreads(threads: readonly WebThread[]): PaletteItem[] {
  return listedThreadItems(
    threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      project: thread.project,
      harness: thread.sessions[0]?.row.harness,
      agents: [...new Set(thread.sessions.map((session) => webHarnessLabel(session.row.harness)))].join(", "),
      where: thread.where === CLOUD_WHERE ? "Cloud" : thread.where,
      at: thread.activityAt,
      standing: thread.standing,
      archived: Boolean(thread.archived),
      apex: thread.apex?.title,
      open: () => opener?.(thread),
    }))
  )
}

/** The browser's Settings sections, for the palette, loaded with Settings' own code when the palette first opens. */
export const loadWebSettings = (): Promise<readonly SettingsEntry[]> => import("./settings-sections").then((module) => module.webSettingsSections(() => undefined))
