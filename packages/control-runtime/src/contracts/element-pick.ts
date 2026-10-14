import { z } from "zod"

/**
 * An element a person picked in a browser tab, as Mako carries it to the
 * composer: what the page said about it, what accessibility calls it, where
 * its component is written, and a crop of it as it looked.
 */
export const PickedElementSchema = z.object({
  tag: z.string().max(200),
  /** Matched exactly this element when it was picked; ` >>> ` steps into an open shadow root. */
  selector: z.string().max(4000).nullable(),
  role: z.string().max(200).optional(),
  name: z.string().max(1000).optional(),
  html: z.string().max(8000),
  styles: z.string().max(8000),
  /** Document coordinates, CSS pixels. */
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  component: z.string().max(200).optional(),
  source: z.object({ file: z.string().max(2000), line: z.number().int().positive().optional(), column: z.number().int().positive().optional() }).optional(),
  /** The chip's words: the component, `tag#id` or the accessible name, at most 40 characters. */
  label: z.string().max(80),
  /** A PNG of the element with a little of what surrounds it. */
  image: z.object({ data: z.string(), mimeType: z.literal("image/png") }).optional(),
  /** An embedded frame: the pick stopped at it. */
  frame: z.boolean(),
})
export type PickedElement = z.infer<typeof PickedElementSchema>

export interface ElementPick {
  url: string
  title: string
  /** What the person typed about the elements; may be empty. */
  comment: string
  /** ⌘↩ (Ctrl+↩): they asked to send at once. */
  send: boolean
  elements: PickedElement[]
}

/** Who ended a pick that picked nothing: the person (Esc, Cancel), the page (it navigated or closed), or Mako. */
export type ElementPickEnd = "person" | "page" | "mako"

export type ElementPickOutcome =
  | { status: "picked"; pick: ElementPick }
  | { status: "cancelled"; by: ElementPickEnd; reason: string }
