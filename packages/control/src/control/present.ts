import { z } from "zod"

/** How an SDK value prints in the REPL. Programs keep the full value; only
 * what an agent reads is compact. Symbol.for crosses the REPL's realm. */
export const PRESENT = Symbol.for("mako.control.present")

/** Attaches a printed form without changing the value's JSON or fields. */
export function presented<T extends object>(value: T, text: (value: T) => string): T {
  Object.defineProperty(value, PRESENT, { value: () => text(value), enumerable: false, configurable: true })
  return value
}

/** The text a REPL prints for a value: a string as itself, an SDK result in
 * the form made for it. A program's own values fail to parse and print as
 * compact JSON exactly as built. */
export const PresentationSchema = z.union([
  z.string(),
  z
    .custom<{ [PRESENT]: () => string }>(
      (value) => value instanceof Object && PRESENT in value && value[PRESENT] instanceof Function
    )
    .transform((value) => z.string().parse(value[PRESENT]())),
])
