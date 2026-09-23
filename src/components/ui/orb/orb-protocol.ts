import type { OrbSize, OrbState } from "thinking-orbs/engine"

export const ORB_STATES = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
] as const satisfies readonly OrbState[]

export const ORB_SIZES = [64, 32, 20] as const satisfies readonly OrbSize[]

export interface OrbTint {
  r: number
  g: number
  b: number
}
