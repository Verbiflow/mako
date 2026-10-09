// What a test's stand-in for macOS `security` needs to speak Mako's side of it
// (`securityKeychain` in electron/keychain.ts): the command, whether given as
// arguments or, under `security -i`, as one line on stdin; and the report of
// `find-generic-password -g`, which goes to stderr, plain for printable text
// and as hex for anything else.
const { readFileSync } = require("node:fs")

/** The command's words: `security -i` reads one line from stdin, split as its reader does. */
exports.command = () => {
  const args = process.argv.slice(2)
  if (args[0] !== "-i") return args
  const words = []
  for (const [, quoted, bare] of readFileSync(0, "utf8").trim().matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g))
    words.push(quoted === undefined ? bare : quoted.replace(/\\(.)/g, "$1"))
  return words
}

/** A command word's value: `-X` holds hex, `-w` the text itself. */
exports.value = (args) => {
  const at = (flag) => args[args.indexOf(flag) + 1]
  return args.includes("-X") ? Buffer.from(at("-X"), "hex").toString("utf8") : at("-w")
}

/** `find-generic-password -g`'s report of the value, as `security` writes it to stderr. */
exports.report = (value) =>
  /^[\x20-\x7e]*$/.test(value)
    ? `password: "${value}"\n`
    : `password: 0x${Buffer.from(value, "utf8").toString("hex").toUpperCase()}  "${value.replace(/[^\x20-\x7e]/g, "\\?")}"\n`
