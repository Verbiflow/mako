/**
 * A value as JavaScript source, for code a test runs in a page (`webContents.executeJavaScript`). `JSON.stringify`
 * alone isn't source: it leaves `<`, `>` and `/` as they are, which end a script element the code is written into,
 * and U+2028 and U+2029, which end a line in older engines. Each is written as its escape, which reads back the same.
 */
const ESCAPES = { "<": "\\u003C", ">": "\\u003E", "/": "\\u002F", "\u2028": "\\u2028", "\u2029": "\\u2029" }

export function literal(value) {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (character) => ESCAPES[character])
}
