import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { z } from "zod"
import { CASES, type MobileCase, type MobileForm, type MobileNeed, type PagePoint } from "./cases.ts"
import { gradeFrames, gradeReadings, judge, ReadingSchema, sampling, verdict, type Frame, type Judged, type Reading, type Sampling } from "./grade.ts"
import { listenForReadings, startSampler, stopSampler, swipeInPage, takeReadings } from "./sampler.ts"

/**
 * Runs the mobile-behavior cases (`cases.ts`) on a target and grades each from the page's own state (`grade.ts`).
 *
 *   node scripts/mobile-behavior/run.ts [--target stand-in|simulator] [--forms phone,tablet] [--cases a,b] [--out <folder>]
 *
 * Node runs it as it is, not tsx: what runs in the page (`sampler.ts`) is sent as its source, and tsx's transform wraps
 * functions in a helper the page doesn't have.
 *
 * `stand-in` is Playwright's WebKit at an iPhone's and an iPad's size, over the phone's live Session fixture
 * (`src/dev/phone-scroll-check.tsx`) built once and opened from disk. It is not iOS: Mobile Safari's scrolling, its
 * keyboard and real touch differ, a swipe there is a touch down and the transcript scrolled by script, and every
 * result says so. Mako doesn't depend on
 * Playwright; give its package with `PLAYWRIGHT_CORE=<folder of playwright-core>`, its WebKit installed.
 *
 * `simulator` is Mobile Safari on an iOS Simulator, driven through Mako's simulator operations; it needs Xcode, and
 * until a host here can drive one it says why and exits 2.
 *
 * It writes `results.jsonl` and `summary.md` into `--out`, prints the summary, and exits 1 when a guard or a control
 * fails or proves nothing.
 */

interface Target {
  label: string
  /** What the target lacks, so cases that need it are listed as not run. */
  lacks: ReadonlySet<MobileNeed>
  open(form: MobileForm, turns: number): Promise<TargetPage>
  close(): Promise<void>
}

interface TargetPage {
  stream(everyMs: number, perBatch: number): Promise<void>
  stopStream(): Promise<void>
  swipe(from: PagePoint, to: PagePoint, ms: number): Promise<void>
  startSampling(): Promise<void>
  stopSampling(): Promise<Frame[]>
  readings(): Promise<Reading[]>
  close(): Promise<void>
}

/** What the stand-in asks of Playwright, named here since Mako doesn't depend on it. */
interface PlaywrightPage {
  addInitScript<Arg>(script: (arg: Arg) => void, arg: Arg): Promise<void>
  goto(url: string): Promise<object | null>
  waitForSelector(selector: string): Promise<object | null>
  evaluate<Result, Arg = undefined>(page: (arg: Arg) => Result | Promise<Result>, arg?: Arg): Promise<Result>
  /** Source the page runs as it is, as an inspector would send it. */
  evaluate(expression: string): Promise<void>
  on(event: "pageerror", listener: (error: Error) => void): void
}
interface PlaywrightRoute {
  request(): { url(): string }
  fulfill(response: { path: string }): Promise<void>
}
interface PlaywrightContext {
  route(url: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  newPage(): Promise<PlaywrightPage>
  close(): Promise<void>
}
interface Playwright {
  webkit: {
    launch(): Promise<{
      version(): string
      newContext(options: { viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean; userAgent: string }): Promise<PlaywrightContext>
      close(): Promise<void>
    }>
  }
}

interface FormSize {
  name: string
  width: number
  height: number
  scale: number
  userAgent: string
}

const FORMS = {
  phone: { name: "iPhone 17 Pro", width: 402, height: 874, scale: 3, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1" },
  tablet: { name: "iPad Pro 13-inch (M5)", width: 1032, height: 1376, scale: 2, userAgent: "Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1" },
} satisfies Record<MobileForm, FormSize>
const READING_EVENT = "mako:reading"
/** Where the stand-in serves the built fixture from: WebKit runs no module scripts from `file:`. */
const FIXTURE_ORIGIN = "http://fixture.mako.test"
/** What `execFile` rejects with when the tool ran and failed. */
const ToolFailure = z.object({ stderr: z.string() })

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "stand-in" },
    forms: { type: "string", default: "phone,tablet" },
    cases: { type: "string" },
    out: { type: "string" },
  },
})
const forms = (values.forms ?? "").split(",").filter((form): form is MobileForm => form === "phone" || form === "tablet")
const chosen = values.cases ? CASES.filter((behavior) => values.cases?.split(",").includes(behavior.id)) : CASES
const out = resolve(values.out ?? (await mkdtemp(join(tmpdir(), "mako-mobile-behavior-"))))
await mkdir(out, { recursive: true })

const target = values.target === "simulator" ? await simulatorTarget() : await standInTarget()
const lines: string[] = [`# Mobile behavior on ${target.label}`, ""]
const results: Array<{ case: string; kind: MobileCase["kind"]; form: MobileForm; target: string; verdict: string; judged?: Judged[]; sampled?: Sampling; notRun?: string; at: string }> = []
let failed = false
try {
  for (const behavior of chosen)
    for (const form of forms) {
      if (!behavior.forms.includes(form)) continue
      const at = new Date().toISOString()
      const missing = behavior.needs?.filter((need) => target.lacks.has(need)) ?? []
      if (missing.length) {
        results.push({ case: behavior.id, kind: behavior.kind, form, target: target.label, verdict: "not run", notRun: `needs ${missing.join(", ")}`, at })
        lines.push(`- ${behavior.id} on ${FORMS[form].name}: not run, needs ${missing.join(", ")}`)
        continue
      }
      const { judged, sampled } = await runCase(target, behavior, form)
      const outcome = verdict(behavior, judged, sampled)
      if (outcome === "fail" || (outcome === "unproven" && behavior.kind !== "bad")) failed = true
      results.push({ case: behavior.id, kind: behavior.kind, form, target: target.label, verdict: outcome, judged, sampled, at })
      const measured = judged.map((entry) => `${entry.metric} ${entry.value ?? "unmeasured"} of ${entry.budget}`).join(", ")
      lines.push(`- ${behavior.id} on ${FORMS[form].name}: ${outcome} (${measured}; ${sampled.frames} frames over ${(sampled.ms / 1000).toFixed(1)} s, turns moved ${sampled.travelPx} px, the end ${sampled.endGrewPx} px farther)`)
    }
} finally {
  await target.close()
}
await writeFile(join(out, "results.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n")
await writeFile(join(out, "summary.md"), `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
console.log(`\nResults: ${out}`)
process.exitCode = failed ? 1 : 0

interface CaseRun {
  judged: Judged[]
  sampled: Sampling
}

async function runCase(on: Target, behavior: MobileCase, form: MobileForm): Promise<CaseRun> {
  const opening = behavior.steps.find((step) => step.do === "open-fixture")
  const page = await on.open(form, opening?.do === "open-fixture" ? (opening.turns ?? 40) : 40)
  let frames: Frame[] = []
  try {
    for (const step of behavior.steps) {
      if (step.do === "stream") {
        await page.stream(step.everyMs, step.perBatch)
        await wait(step.forMs)
      } else if (step.do === "stop-stream") await page.stopStream()
      else if (step.do === "swipe") await page.swipe(step.from, step.to, step.ms)
      else if (step.do === "wait") await wait(step.ms)
      else if (step.do === "sample") {
        if (step.on) await page.startSampling()
        else frames = await page.stopSampling()
      }
    }
    return { judged: judge(behavior, { ...gradeFrames(frames), ...gradeReadings(await page.readings()) }), sampled: sampling(frames) }
  } finally {
    await page.close()
  }
}

/** Playwright's WebKit at the form's size, touch on, over the fixture built once from this checkout. */
async function standInTarget(): Promise<Target> {
  const require = createRequire(import.meta.url)
  const from = process.env.PLAYWRIGHT_CORE ? resolve(process.env.PLAYWRIGHT_CORE) : "playwright-core"
  let playwright: Playwright
  try {
    // SAFETY: playwright-core's module, which has `webkit` as `Playwright` names it.
    playwright = require(from) as Playwright
  } catch {
    console.error("The stand-in needs Playwright's WebKit: PLAYWRIGHT_CORE=<folder of playwright-core>, with `npx playwright-core install webkit` run once.")
    process.exit(2)
  }
  const work = await mkdtemp(join(tmpdir(), "mako-mobile-fixture-"))
  process.env.NODE_ENV = "development"
  const { build } = await import("vite")
  await build({ mode: "development", logLevel: "warn", base: "./", build: { outDir: work, emptyOutDir: true, minify: false, rollupOptions: { input: resolve("scripts/phone-scroll.html") } } })
  const browser = await playwright.webkit.launch()
  return {
    label: `WebKit stand-in (Playwright WebKit ${browser.version()}): not iOS, swipes scrolled by script`,
    lacks: new Set<MobileNeed>(["keyboard", "microphone", "signed-in"]),
    async open(form, turns) {
      const size = FORMS[form]
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: true, hasTouch: true, userAgent: size.userAgent })
      await context.route(`${FIXTURE_ORIGIN}/**`, (route) => route.fulfill({ path: join(work, new URL(route.request().url()).pathname) }))
      const page = await context.newPage()
      page.on("pageerror", (error) => console.error(`The fixture threw on ${size.name}: ${error.message}`))
      await page.addInitScript(listenForReadings, READING_EVENT)
      await page.goto(`${FIXTURE_ORIGIN}/scripts/phone-scroll.html?turns=${turns}`)
      await page.waitForSelector(".web-live [data-exchange]")
      await wait(300)
      return {
        stream: (everyMs, perBatch) => page.evaluate(`window.scrollCheck.stream(${everyMs}, ${perBatch})`),
        stopStream: () => page.evaluate("window.scrollCheck.stop()"),
        swipe: (from, to, ms) => page.evaluate(swipeInPage, { live: ".web-live", dy: (to[1] - from[1]) * size.height, ms }),
        startSampling: () => page.evaluate(startSampler, ".web-live"),
        stopSampling: () => page.evaluate(stopSampler),
        readings: async () => (await page.evaluate(takeReadings)).flatMap((said) => ReadingSchema.safeParse(JSON.parse(said)).data ?? []),
        close: () => context.close(),
      }
    },
    async close() {
      await browser.close()
      await rm(work, { recursive: true, force: true })
    },
  }
}

/** Mobile Safari on a simulator: until a host here drives one, the reason it can't, from Xcode's own tools. */
async function simulatorTarget(): Promise<Target> {
  const run = promisify(execFile)
  const simctl = await run("/usr/bin/xcrun", ["simctl", "help"]).then(
    () => undefined,
    (error) => ToolFailure.safeParse(error).data?.stderr.trim() ?? String(error)
  )
  console.error(simctl ? `The simulator target needs Xcode, and this Mac has none: ${simctl}` : "Xcode is here; driving a simulator from this runner is built next, through Mako's simulator operations.")
  process.exit(2)
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
