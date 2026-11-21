// Loaded through NODE_OPTIONS (`--require`) into a host under test and, with its environment, into every Node process
// it starts: each process any of them starts is appended to MAKO_TEST_PROCESS_STARTS as a line of JSON, when it
// starts. A listing of processes taken every second or two misses one that runs for twenty milliseconds, as the
// `security` an idle host ran every minute did. Without the variable it does nothing.
const childProcess = require("node:child_process")
const { appendFileSync } = require("node:fs")
const { basename } = require("node:path")
const { promisify } = require("node:util")

const out = process.env.MAKO_TEST_PROCESS_STARTS
if (out) {
  const by = basename(process.argv[1] ?? "node")
  const note = (file, args) => {
    try {
      appendFileSync(out, `${JSON.stringify({ at: Date.now(), by, file: String(file), args: Array.isArray(args) ? args.map(String).slice(0, 6) : [] })}\n`)
    } catch {
      // A log that can't be written changes nothing the process does.
    }
  }
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const real = childProcess[name]
    const wrapped = function (file, args, ...rest) {
      note(file, args)
      return real.call(this, file, args, ...rest)
    }
    // `util.promisify(execFile)` answers through the function's own promise form: kept, and logged too.
    const promised = real[promisify.custom]
    if (promised) Object.defineProperty(wrapped, promisify.custom, { value: (file, args, ...rest) => { note(file, args); return promised(file, args, ...rest) } })
    childProcess[name] = wrapped
  }
}
