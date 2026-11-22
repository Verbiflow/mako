// For running a suite written with one style of path against code given another: `translating(target, into, out)` is
// `target` with every string in a method's arguments (in arrays, plain objects, maps and sets too) passed through
// `into`, and every string in what it returns, or resolves to, through `out`.

/** `value` with every string in it (keys of maps too) passed through `turn`; functions and class instances as they are. */
export function mapped(value, turn) {
  if (Object.prototype.toString.call(value) === "[object String]") return turn(value)
  if (Array.isArray(value)) return value.map((item) => mapped(item, turn))
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [mapped(key, turn), mapped(item, turn)]))
  if (value instanceof Set) return new Set([...value].map((item) => mapped(item, turn)))
  if (!(value instanceof Object) || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapped(item, turn)]))
}

/**
 * @template {object} T
 * @param {T} target
 * @param {(text: string) => string} into
 * @param {(text: string) => string} out
 * @returns {T}
 */
export function translating(target, into, out) {
  return new Proxy(target, {
    get(inner, key) {
      const member = inner[key]
      if (!(member instanceof Function)) return member
      return (...args) => {
        const result = member.apply(inner, args.map((arg) => mapped(arg, into)))
        return result instanceof Promise ? result.then((settled) => mapped(settled, out)) : mapped(result, out)
      }
    },
  })
}
