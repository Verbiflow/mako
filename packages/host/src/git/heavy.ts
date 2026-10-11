import { lazyPackage } from "@mako/lazy"

/** Git's modules built around a heavy package, each loaded the first time a feature needs it. */
export const adapters = {
  /** The AI SDK and its providers, for utility models. */
  utilityLanguage: lazyPackage("ai, @ai-sdk/* (utility-language.ts)", () => import("./utility-language.js")),
}
