import type { HarnessPresentation } from "@mako/host/contracts/harness-presentation"

/** OpenCode's open square. */
export const openCodePresentation: HarnessPresentation = {
  mark: {
    viewBox: "0 0 24 24",
    paths: [
      { d: "M22 24H2V0h20zM17 4.8H7v14.4h10z" },
    ],
    tint: "currentColor",
  },
}
