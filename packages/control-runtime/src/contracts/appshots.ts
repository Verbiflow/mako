import { z } from "zod"
import type { ControlImage } from "./control-preview.js"

export const AppshotTargetSchema = z
  .object({
    pid: z.number().int().positive(),
    windowId: z.number().int().positive(),
  })
  .strict()
export type AppshotTarget = z.infer<typeof AppshotTargetSchema>
export interface AppshotWindow extends AppshotTarget {
  app: string
  title: string
  thumbnail?: ControlImage
  icon?: ControlImage
  /** Where the window is, in screen points from the top-left of the main display. */
  bounds?: { x: number; y: number; width: number; height: number }
}
export interface Appshot {
  window: AppshotWindow
  capturedAt: number
  image: ControlImage
  /**
   * The window's elements as the agent reads them: one per line, indented
   * under what holds it, each with its box in `image`'s pixels
   * (`@mako/control/computer/outline`). Builds before October 12 put the
   * driver's flat accessibility text here.
   */
  text: string
  /** Some elements were left out: the driver stopped early, or the outline's budget ran out. */
  truncated: boolean
  /** How many elements `text` lists. */
  elements?: number
}

/** The window an Appshot shortcut takes: the one the person is in, never Mako's own. */
export const AppshotFrontRequestSchema = z
  .object({
    /** Processes whose windows are never the answer: the Mako app that asked. */
    exclude: z.array(z.number().int().positive()).max(16),
    /**
     * The app in front when the shortcut was pressed. Another app that
     * answers the same keys can come to the front within milliseconds, so
     * the front app read at capture time may be that one, not the person's.
     */
    front: z.number().int().positive().optional(),
  })
  .strict()
export type AppshotFrontRequest = z.infer<typeof AppshotFrontRequestSchema>
