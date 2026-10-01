/** How an SDK value prints in the REPL. Programs keep the full value; only
 * what an agent reads is compact. Symbol.for crosses the REPL's realm. */
export const PRESENT = Symbol.for("mako.control.present")

type Presentable = { [PRESENT]?: () => string }

/** Attaches a printed form without changing the value's JSON or fields. */
export function presented<T extends object>(value: T, text: (value: T) => string): T {
  Object.defineProperty(value, PRESENT, { value: () => text(value), enumerable: false, configurable: true })
  return value
}

/** The text a REPL prints for a value: a string as itself, an SDK result in
 * the form made for it. Undefined for the program's own values, which print
 * as compact JSON exactly as built. */
export function presentation(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const present = (value as Presentable)[PRESENT]
    if (typeof present === "function") return present.call(value)
  }
  return undefined
}
