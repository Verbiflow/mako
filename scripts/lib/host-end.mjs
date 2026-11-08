/**
 * A test's host ended and what the test left behind cleared, whatever fails on the way. `quit` asks the host to quit
 * and says whether it did. One that didn't has its logs kept (`keep`) and is killed (`kill`), each tried whatever the
 * other did. Then every step of `cleanup` runs in its order, each whatever came before it: a keychain item left by a
 * test that failed here stays on the Mac it ran on. A step that fails is reported with `report` and never stops the
 * next. Resolves to whether the host quit by itself.
 */
export async function endHost({ quit, keep, kill, cleanup, report = (line) => console.error(line) }) {
  const attempt = async (what, step) => {
    try {
      await step()
      return true
    } catch (error) {
      report(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  let quitByItself = false
  try {
    try {
      quitByItself = await quit()
    } finally {
      if (!quitByItself) {
        try {
          await attempt("keeping the host's logs", keep)
        } finally {
          await attempt("killing the host", kill)
        }
      }
    }
  } catch (error) {
    report(`asking the host to quit failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    for (const [what, step] of cleanup) await attempt(what, step)
  }
  return quitByItself
}
