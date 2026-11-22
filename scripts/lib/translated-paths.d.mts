/** `value` with every string in it (keys of maps too) passed through `turn`; functions and class instances as they are. */
export function mapped<T>(value: T, turn: (text: string) => string): T
/** `target` with every string in a method's arguments passed through `into`, and in what it returns through `out`. */
export function translating<T extends object>(target: T, into: (text: string) => string, out: (text: string) => string): T
