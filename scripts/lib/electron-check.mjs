/**
 * Every way an Electron UI check can end says why. A check that ran past
 * its time, a rejection or exception nothing caught, a renderer that went
 * away or a page that didn't load each print the cause and the step it was
 * on before the process exits 1; the launching process prints how its
 * Electron child ended when that wasn't 0. A watchdog that called
 * `app.exit(1)` alone once ended `test:rail-ui` with no word of why.
 */
export function guardElectronCheck({ app, page, name, ms }) {
  let step = "starting"
  let failed = false
  const fail = (cause) => {
    if (failed) return
    failed = true
    console.error(`${name} failed at "${step}": ${cause}`)
    app.exit(1)
  }
  const timer = setTimeout(() => fail(`it ran past ${Math.round(ms / 1000)} s`), ms)
  process.on("unhandledRejection", (reason) => fail(`an unhandled rejection: ${described(reason)}`))
  process.on("uncaughtException", (error) => fail(`an uncaught exception: ${described(error)}`))
  page.on("render-process-gone", (_event, details) => fail(`the page's renderer went (${details.reason}, exit code ${details.exitCode})`))
  // -3 is a navigation the check itself replaced with the next one.
  page.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) fail(`the page didn't load: ${description} (${code}) ${url}`)
  })
  return {
    /** The step under way, named in any failure. */
    at(next) {
      step = next
    },
    fail,
    done() {
      clearTimeout(timer)
    },
  }
}

/** The launching side: how the Electron child ended, said when it wasn't 0, as the exit code to keep. */
export function electronExit(name, code, signal) {
  if (code === 0) return 0
  console.error(`${name}: its Electron process ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`)
  return code || 1
}

function described(value) {
  return value instanceof Error ? value.stack ?? value.message : String(value)
}
