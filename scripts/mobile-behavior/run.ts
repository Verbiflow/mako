import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { extname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { CASES, deviceLabel, type MobileCase, type MobileForm, type MobileNeed, type PagePoint } from "./cases.ts"
import { caseVerdict, failsRun, gradeFrames, gradeReadings, judge, ReadingSchema, sampling, verdict, type Frame, type Judged, type Reading, type Sampling, type Verdict } from "./grade.ts"
import { listenForReadings, startSampler, stopSampler, swipeInPage, takeReadings } from "./sampler.ts"

/**
 * Runs the mobile-behavior cases (`cases.ts`) on a target and grades each from the page's own state (`grade.ts`).
 *
 *   node scripts/mobile-behavior/run.ts [--target stand-in|simulator] [--forms phone,tablet] [--cases a,b] [--samples 3] [--out <folder>]
 *     [--web <url>] [--data <folder>] [--record]
 *   node scripts/mobile-behavior/run.ts --list
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
 * `simulator` is Mobile Safari on Mako's iPhone and iPad simulators, driven by the host the app runs (`simulator.ts`)
 * over `--data` (its own tools and hub, never the app's): the fixture served to Safari from this Mac, swipes as real
 * touches, the page read through WebKit's inspector. It installs the tools and makes the simulators if they're missing;
 * when this Mac can't run one (no Xcode, its setup unfinished) it says why and exits 2. Its iOS keyboard is real, so
 * the keyboard case runs; dictation and a signed-in Thread don't.
 *
 * `--web <url>` then opens a page of the real web app (`https://app.runmako.co`) on each form, a simulator only, and
 * reports what its probe said there (`mako:reading`), its console's errors and a screenshot, ungraded. `--record`
 * records each simulator's screen for the whole run into `--out`. `npm run mobile-behavior:simulator` is all of it.
 *
 * Each case runs `--samples` times on each form (3 by default), and its samples are judged together (`caseVerdict`):
 * one that throws is an error, recorded and left out of the grade, not the end of the run. It writes one row per
 * sample to `results.jsonl` and one line per case and form to `summary.md` in `--out`, prints the summary, and exits
 * 1 when a guard or a control fails, proves nothing or is incomplete.
 */

interface Target {
  label: string
  /** What runs `form` here, named as it is, for the summary's lines. */
  device(form: MobileForm): string
  /** What the target lacks, so cases that need it are listed as not run. */
  lacks: ReadonlySet<MobileNeed>
  open(form: MobileForm, turns: number): Promise<TargetPage>
  /** `--web`: the page at `url` watched for `ms` on `form`, where the target runs real pages. */
  visit?(form: MobileForm, url: string, ms: number): Promise<Visit>
  close(): Promise<void>
}

interface Visit {
  device: string
  readings: unknown[]
  errors: string[]
  shot?: string
}

interface TargetPage {
  stream(everyMs: number, perBatch: number): Promise<void>
  stopStream(): Promise<void>
  swipe(from: PagePoint, to: PagePoint, ms: number): Promise<void>
  keyboard(shown: boolean): Promise<void>
  startSampling(): Promise<void>
  stopSampling(): Promise<Frame[]>
  readings(): Promise<Reading[]>
  /** What the page threw since it opened: a sample whose page threw is an error, not a grade. */
  errors(): Promise<string[]>
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
/** Where the stand-in serves the built fixture from: WebKit runs no module scripts from `file:`, and the web client needs a secure context (`crypto.randomUUID`), as on app.runmako.co. */
const FIXTURE_ORIGIN = "https://fixture.mako.test"
/** What `stopSampler` returns, as the inspector hands it back: JSON, so each turn's entry is a pair. */
const FramesSchema = z.array(z.object({ at: z.number(), fromEnd: z.number(), rows: z.array(z.tuple([z.string(), z.number()])) }))
/** How long `--web` watches a page: long enough for a sign-in's token exchange to settle or storm. */
const WEB_WATCH_MS = 15_000
const CONTENT_TYPES = new Map([[".html", "text/html"], [".js", "text/javascript"], [".css", "text/css"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"], [".json", "application/json"]])

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "stand-in" },
    forms: { type: "string", default: "phone,tablet" },
    cases: { type: "string" },
    samples: { type: "string", default: "3" },
    list: { type: "boolean" },
    out: { type: "string" },
    web: { type: "string" },
    data: { type: "string" },
    record: { type: "boolean", default: false },
  },
})
if (values.list) {
  for (const behavior of CASES) console.log(`${behavior.id} (${behavior.kind}; ${behavior.forms.join(", ")}${behavior.needs?.length ? `; needs ${behavior.needs.join(", ")}` : ""}): ${behavior.experience}`)
  process.exit(0)
}
const samples = Number(values.samples)
if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples is a whole number of runs per case, not ${values.samples}`)
const forms = (values.forms ?? "").split(",").filter((form): form is MobileForm => form === "phone" || form === "tablet")
const chosen = values.cases ? CASES.filter((behavior) => values.cases?.split(",").includes(behavior.id)) : CASES
const out = resolve(values.out ?? (await mkdtemp(join(tmpdir(), "mako-mobile-behavior-"))))
await mkdir(out, { recursive: true })

const target = values.target === "simulator" ? await simulatorTarget() : await standInTarget()
const lines: string[] = [`# Mobile behavior on ${target.label}`, ""]
const results: Array<{ case: string; kind: MobileCase["kind"]; form: MobileForm; target: string; device: string; sample?: number; verdict: string; judged?: Judged[]; sampled?: Sampling; error?: string; notRun?: string; at: string }> = []
let failed = false
try {
  for (const behavior of chosen)
    for (const form of forms) {
      if (!behavior.forms.includes(form)) continue
      const missing = behavior.needs?.filter((need) => target.lacks.has(need)) ?? []
      if (missing.length) {
        results.push({ case: behavior.id, kind: behavior.kind, form, target: target.label, device: target.device(form), verdict: "not run", notRun: `needs ${missing.join(", ")}`, at: new Date().toISOString() })
        lines.push(`- ${behavior.id} on ${target.device(form)}: not run, needs ${missing.join(", ")}`)
        continue
      }
      const verdicts: (Verdict | "error")[] = []
      const said: string[] = []
      for (let sample = 1; sample <= samples; sample++) {
        const at = new Date().toISOString()
        try {
          const { judged, sampled } = await runCase(target, behavior, form)
          const outcome = verdict(behavior, judged, sampled)
          verdicts.push(outcome)
          results.push({ case: behavior.id, kind: behavior.kind, form, target: target.label, device: target.device(form), sample, verdict: outcome, judged, sampled, at })
          const measured = judged.map((entry) => `${entry.metric} ${entry.value ?? "unmeasured"} of ${entry.budget}`).join(", ")
          said.push(`${outcome} (${measured}; ${sampled.frames} frames over ${(sampled.ms / 1000).toFixed(1)} s, turns moved ${sampled.travelPx} px, the end ${sampled.endGrewPx} px farther)`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          verdicts.push("error")
          results.push({ case: behavior.id, kind: behavior.kind, form, target: target.label, device: target.device(form), sample, verdict: "error", error: message, at })
          said.push(`error (${message})`)
        }
      }
      const outcome = caseVerdict(behavior, verdicts)
      if (failsRun(behavior, outcome)) failed = true
      lines.push(`- ${behavior.id} on ${target.device(form)}: ${outcome}`, ...said.map((line, index) => `  - sample ${index + 1}: ${line}`))
    }
  if (values.web) await visitWeb(target, values.web)
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
      else if (step.do === "keyboard") await page.keyboard(step.shown)
      else if (step.do === "wait") await wait(step.ms)
      else if (step.do === "sample") {
        if (step.on) await page.startSampling()
        else frames = await page.stopSampling()
      }
    }
    const readings = await page.readings()
    const threw = await page.errors()
    if (threw.length) throw new Error(`the page threw: ${[...new Set(threw)].join("; ")}`)
    return { judged: judge(behavior, { ...gradeFrames(frames), ...gradeReadings(readings) }), sampled: sampling(frames) }
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
  const work = await buildFixture()
  const browser = await playwright.webkit.launch()
  return {
    label: `WebKit stand-in (Playwright WebKit ${browser.version()}): not iOS, swipes scrolled by script`,
    lacks: new Set<MobileNeed>(["keyboard", "microphone", "signed-in"]),
    device: (form) => deviceLabel({ name: `WebKit at ${FORMS[form].name}'s size` }),
    async open(form, turns) {
      const size = FORMS[form]
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, isMobile: true, hasTouch: true, userAgent: size.userAgent })
      await context.route(`${FIXTURE_ORIGIN}/**`, (route) => route.fulfill({ path: join(work, new URL(route.request().url()).pathname) }))
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.addInitScript(listenForReadings, READING_EVENT)
      await page.goto(`${FIXTURE_ORIGIN}/scripts/phone-scroll.html?turns=${turns}`)
      await page.waitForSelector(".web-live [data-exchange]")
      await wait(300)
      return {
        stream: (everyMs, perBatch) => page.evaluate(`window.scrollCheck.stream(${everyMs}, ${perBatch})`),
        stopStream: () => page.evaluate("window.scrollCheck.stop()"),
        swipe: (from, to, ms) => page.evaluate(swipeInPage, { live: ".web-live", dy: (to[1] - from[1]) * size.height, ms }),
        keyboard: () => Promise.reject(new Error("The stand-in has no software keyboard.")),
        startSampling: () => page.evaluate(startSampler, ".web-live"),
        stopSampling: () => page.evaluate(stopSampler),
        errors: async () => errors,
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

/** Mobile Safari on Mako's iPhone and iPad: the fixture served from this Mac, touched for real, read through the inspector. */
async function simulatorTarget(): Promise<Target> {
  const { tsImport } = await import("tsx/esm/api")
  // SAFETY: `simulator.ts`'s module, which tsx loads as it is written.
  const { localSimulators } = (await tsImport("./simulator.ts", import.meta.url)) as typeof import("./simulator.ts")
  const local = await localSimulators(resolve(values.data ?? join(tmpdir(), "mako-mobile-behavior-simulators")), (line) => console.error(line))
  if ("blocked" in local) {
    console.error(`The simulator target can't run on this Mac: ${local.blocked}`)
    process.exit(2)
  }
  const { host } = local
  const of = (form: MobileForm) => {
    const simulator = local.simulators.find((entry) => entry.form === form)
    if (!simulator) throw new Error(`Mako has no ${form} simulator here.`)
    return simulator
  }
  for (const form of forms) if (of(form).state !== "booted") await host.boot(of(form).id)
  if (values.record) for (const form of forms) await host.record(of(form).id, "start")
  const work = await buildFixture()
  const fixture = createServer((request, response) => {
    const path = join(work, new URL(request.url ?? "/", "http://fixture").pathname)
    readFile(path).then(
      (body) => response.writeHead(200, { "content-type": CONTENT_TYPES.get(extname(path)) ?? "application/octet-stream", "cache-control": "no-store" }).end(body),
      () => response.writeHead(404).end()
    )
  })
  // Loopback: a simulator shares this Mac's network, so Safari there reaches it and nothing else does.
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done))
  const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(fixture.address()).port}`
  const evaluate = (udid: string, expression: string) => host.evaluate(udid, expression)
  const until = async (udid: string, expression: string, what: string, ms = 30_000) => {
    const started = Date.now()
    while (Date.now() - started < ms) {
      if ((await evaluate(udid, expression).catch(() => false)) === true) return
      await wait(250)
    }
    throw new Error(`Safari on ${udid} didn't ${what} within ${ms / 1000} s.`)
  }
  const readings = async (udid: string) => z.array(z.unknown()).parse(await evaluate(udid, "(window.__makoReadings ?? []).map((kept) => kept.reading)"))
  const ConsoleSchema = z.array(z.object({ level: z.string(), text: z.string() }))
  /** The console since `after`: what it logged, and the cursor to read on from. */
  const logged = async (udid: string, after: number) => {
    const read = await host.read(udid, "console", after)
    return { entries: ConsoleSchema.parse(read.state), cursor: read.cursor ?? after }
  }
  const device = (form: MobileForm) => {
    const simulator = of(form)
    const type = local.types.get(simulator.id)
    return deviceLabel({ name: simulator.name, runtime: simulator.runtime, ...(type && { type }) })
  }
  return {
    label: `Mobile Safari on ${forms.map(device).join(" and ")}`,
    lacks: new Set<MobileNeed>(["microphone", "signed-in"]),
    device,
    async open(form, turns) {
      const simulator = of(form)
      const url = `${origin}/scripts/phone-scroll.html?turns=${turns}&run=${Date.now()}`
      const since = (await logged(simulator.id, 0).catch(() => ({ cursor: 0 }))).cursor
      await host.act(simulator.id, { kind: "open-url", url })
      await until(simulator.id, `location.href === ${JSON.stringify(url)} && document.querySelector(".web-live [data-exchange]") !== null`, "open the fixture")
      await wait(300)
      const viewport = z.object({ width: z.number(), height: z.number() }).parse(await evaluate(simulator.id, "({ width: innerWidth, height: innerHeight })"))
      const screen = simulator.screen ?? { width: viewport.width, height: viewport.height }
      // The page's fractions on the screen: across its width, and its height about the screen's middle, where
      // Safari's bars leave the page; a case's swipes are vertical, so what they move is the page's own distance.
      const at = (point: PagePoint) => ({ x: point[0] * screen.width, y: screen.height / 2 + (point[1] - 0.5) * viewport.height })
      return {
        stream: async (everyMs, perBatch) => void (await evaluate(simulator.id, `window.scrollCheck.stream(${everyMs}, ${perBatch})`)),
        stopStream: async () => void (await evaluate(simulator.id, "window.scrollCheck.stop()")),
        swipe: (from, to, ms) => host.act(simulator.id, { kind: "swipe", from: at(from), to: at(to), ms }),
        keyboard: (shown) => host.act(simulator.id, { kind: "keyboard", shown }),
        startSampling: async () => void (await evaluate(simulator.id, `(${startSampler.toString()})(".web-live")`)),
        stopSampling: async () => FramesSchema.parse(await evaluate(simulator.id, `(${stopSampler.toString()})()`)),
        readings: async () => (await readings(simulator.id)).flatMap((said) => ReadingSchema.safeParse(said).data ?? []),
        errors: async () => (await logged(simulator.id, since)).entries.filter((entry) => entry.level === "exception").map((entry) => entry.text),
        close: async () => undefined,
      }
    },
    async visit(form, url, ms) {
      const simulator = of(form)
      const since = (await logged(simulator.id, 0).catch(() => ({ cursor: 0 }))).cursor
      await host.act(simulator.id, { kind: "open-url", url })
      await until(simulator.id, `location.href.startsWith(${JSON.stringify(new URL(url).origin)}) && document.readyState === "complete"`, `open ${url}`, 60_000)
      await wait(ms)
      const errors = (await logged(simulator.id, since)).entries.filter((entry) => entry.level === "error" || entry.level === "exception").map((entry) => entry.text)
      const shot = await host.screenshot(simulator.id)
      const kept = join(out, `web-${form}.png`)
      await copyFile(shot.path, kept)
      return { device: device(form), readings: await readings(simulator.id), errors, shot: kept }
    },
    async close() {
      fixture.close()
      if (values.record)
        for (const form of forms) {
          const recorded = await host.record(of(form).id, "stop").catch(() => ({ path: undefined }))
          if (recorded.path) await copyFile(recorded.path, join(out, `recording-${form}.mp4`))
        }
      await local.close()
      await rm(work, { recursive: true, force: true })
    },
  }
}

/** `--web`: what the real web app's page reports on each form, ungraded, with each kind of reading counted. */
async function visitWeb(on: Target, url: string): Promise<void> {
  lines.push("", `## ${url}`, "")
  if (!on.visit) {
    lines.push(`- not run: ${on.label} runs only the fixture.`)
    return
  }
  for (const form of forms) {
    const visit = await on.visit(form, url, WEB_WATCH_MS)
    const named = new Map<string, number>()
    for (const said of visit.readings) {
      const name = z.object({ name: z.string() }).safeParse(said).data?.name ?? "unnamed"
      named.set(name, (named.get(name) ?? 0) + 1)
    }
    const counted = [...named].map(([name, count]) => `${name} ×${count}`).join(", ") || "none"
    lines.push(`- ${visit.device}, ${WEB_WATCH_MS / 1000} s: readings ${counted}; ${visit.errors.length} console errors${visit.shot ? `; ${visit.shot}` : ""}`)
    for (const error of visit.errors.slice(0, 5)) lines.push(`  - ${error.split("\n")[0]}`)
    await writeFile(join(out, `web-${form}.json`), JSON.stringify(visit, null, 2))
  }
}

/** The phone's live Session fixture, built once from this checkout into a folder of its own. */
async function buildFixture(): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "mako-mobile-fixture-"))
  process.env.NODE_ENV = "development"
  const { build } = await import("vite")
  await build({ mode: "development", logLevel: "warn", base: "./", build: { outDir: work, emptyOutDir: true, minify: false, rollupOptions: { input: resolve("scripts/phone-scroll.html") } } })
  return work
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
