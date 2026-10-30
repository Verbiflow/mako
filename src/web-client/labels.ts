import { harnessFaces } from "@/dev/harness-faces"

/** A harness's name as Mako shows it everywhere ("Claude Code"), from the harness definitions. */
export function webHarnessLabel(harness: string): string {
  return harnessFaces.find((face) => face.provider === harness)?.displayName ?? harness
}

/** Every harness, in Mako's order. */
export const WEB_HARNESSES: readonly string[] = harnessFaces.map((face) => face.provider)
