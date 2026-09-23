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
}
export interface Appshot {
  window: AppshotWindow
  capturedAt: number
  image: ControlImage
  text: string
  truncated: boolean
}
