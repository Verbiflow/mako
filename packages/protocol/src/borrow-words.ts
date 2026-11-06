/**
 * Borrowing's operations in the person's words, the same on every surface that says them: Settings › Fins on the
 * device that lends one, Setup, and the agent's own tool answers.
 */
const OPERATIONS = {
  "ios-simulator": "an iOS simulator",
  "android-emulator": "an Android emulator",
  xcode: "Xcode",
  gpu: "a GPU",
  macos: "a Mac",
  cli: "a command-line tool",
} as const satisfies Record<string, string>

/** What an operation or a capability is, as a person says it: "an iOS simulator". */
export function operationWords(ref: string): string {
  return isKnown(ref) ? OPERATIONS[ref] : ref
}

function isKnown(ref: string): ref is keyof typeof OPERATIONS {
  return Object.hasOwn(OPERATIONS, ref)
}
