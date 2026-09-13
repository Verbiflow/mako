import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import type { Exchange as ExchangeData } from "@/lib/exchanges"
// Explicit fixture page: /scripts/ui-pilot-browser.html. Never imported by Mako.
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { Prose } from "@/components/transcript/markdown"
import { Divider } from "@/components/shell/divider"
import { OceanScene } from "@/components/ui/ocean-scene"
import { Transcript } from "@/components/transcript/transcript"
import { Composer } from "@/components/composer/composer"
import { store as sessionStore } from "@/state/session"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
const page = document.getElementById("root")!
page.className = "p-8 text-ui"
const button = document.createElement("button")
button.className =
  "pressable rounded-md bg-primary px-3 py-2 text-primary-foreground"
button.textContent = "Run UI regression checks"
const output = document.createElement("pre")
output.className = "my-4 whitespace-pre-wrap text-ui"
output.textContent =
  "Tests use the production components and a fixture clipboard. No agent is started."
const fixture = document.createElement("div")
// Keep visibility-sensitive components onscreen as the result log grows.
fixture.className = "fixed bottom-0 right-0 isolate w-full max-w-content"
page.append(button, output, fixture)
const root = createRoot(fixture)

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
  output.textContent += `\nPASS ${message}`
}

async function until(test: () => boolean) {
  const deadline = performance.now() + 3000
  while (!test()) {
    if (performance.now() > deadline) throw new Error("UI condition timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function openingDraft() {
  sessionStore.set({ messages: [], stream: null })
  flushSync(() =>
    root.render(
      <TooltipProvider>
        <main className="agent-surface relative isolate flex h-[640px] flex-col overflow-hidden">
          <Transcript />
          <Composer />
        </main>
      </TooltipProvider>
    )
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  const scene = fixture.querySelector<HTMLElement>(".ocean-scene")
  const heading = fixture.querySelector<HTMLElement>(".text-welcome")
  const input = fixture.querySelector<HTMLTextAreaElement>(".composer-input")
  check(scene !== null, "the empty transcript mounts its artwork")
  check(heading !== null, "the empty transcript mounts its heading")
  check(input !== null, "the empty transcript mounts its composer")
  await Promise.all(
    scene
      .getAnimations()
      .filter(
        (animation) => animation.effect?.getTiming().iterations !== Infinity
      )
      .map((animation) => animation.finished)
  )
  const pane = fixture.querySelector("main")!
  const paneTop = () => pane.getBoundingClientRect().top
  const bounds = scene.getBoundingClientRect()
  const sceneTop = bounds.top - paneTop()
  const headingTop = heading.getBoundingClientRect().top - paneTop()
  const inputHeight = input.getBoundingClientRect().height
  const wake = fixture.querySelector<HTMLElement>(".ocean-light")!
  check(
    getComputedStyle(wake).animationPlayState === "running",
    "reflected light animates before writing"
  )
  input.focus({ preventScroll: true })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(
    input.getBoundingClientRect().height === inputHeight,
    "focusing an empty composer does not change its height"
  )
  check(
    getComputedStyle(wake).animationPlayState === "paused",
    "focusing the composer pauses reflected light"
  )
  for (const lines of [1, 12, 30]) {
    window.dispatchEvent(
      new CustomEvent("mako:compose", {
        detail: {
          text: Array.from(
            { length: lines },
            (_, i) => `Layout check ${i + 1}`
          ).join("\n"),
        },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    const current = scene.getBoundingClientRect()
    check(
      current.top - paneTop() === sceneTop && current.height === bounds.height,
      `the ocean stays fixed with a ${lines}-line draft`
    )
    check(
      heading.getBoundingClientRect().top - paneTop() === headingTop,
      `the opening heading stays fixed with a ${lines}-line draft`
    )
  }
  window.dispatchEvent(
    new CustomEvent("mako:compose", { detail: { text: "" } })
  )
  await new Promise((resolve) => requestAnimationFrame(resolve))
  flushSync(() => root.render(null))
}

async function paragraphs() {
  await document.fonts.ready
  const text =
    "A paragraph keeps its native text selection and browser line breaking while an estimate reserves space. ".repeat(
      35
    )
  for (const width of [360, 640, 900]) {
    const previous = fixture.querySelector("p")?.style.containIntrinsicBlockSize
    flushSync(() =>
      root.render(
        <div style={{ width }}>
          <Prose text={text} />
        </div>
      )
    )
    const paragraph = fixture.querySelector("p")!
    await until(
      () =>
        paragraph.style.containIntrinsicBlockSize !== "" &&
        paragraph.style.containIntrinsicBlockSize !== previous
    )
    const intrinsic = Number.parseFloat(
      paragraph.style.containIntrinsicBlockSize.replace("auto ", "")
    )
    const line = Number.parseFloat(getComputedStyle(paragraph).lineHeight)
    const actual = paragraph.getBoundingClientRect().height
    check(
      Math.abs(intrinsic - actual) <= line * 2 + 1,
      `native paragraph and estimate agree within two lines at ${width}px`
    )
    check(
      paragraph.textContent === text.trimEnd(),
      "paragraph text is unchanged"
    )
  }
  flushSync(() => root.render(<Prose text={text} streaming />))
  await until(
    () => !fixture.querySelector("p")?.hasAttribute("data-estimated-paragraph")
  )
  check(
    fixture.querySelector("p")?.style.containIntrinsicBlockSize === "",
    "streaming disables preparation and estimates"
  )
  flushSync(() =>
    root.render(
      <Prose
        text={`**Styled text** ${text}\n\n| Column | Value |\n| --- | --- |\n| Row | Native table |`}
      />
    )
  )
  check(
    fixture.querySelector("p")?.style.containIntrinsicBlockSize === "",
    "styled paragraphs stay entirely native"
  )
  check(
    fixture.querySelectorAll("table").length === 1,
    "GFM still renders as a real table"
  )
}

function deferred() {
  let resolve: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve() }
}

async function transcriptAnchor() {
  const exchanges: ExchangeData[] = Array.from({ length: 60 }, (_, index) => ({
    id: `exchange-${index}`,
    system: [],
    response: [
      {
        id: `answer-${index}`,
        role: "assistant",
        blocks: [
          {
            type: "text",
            text: "The browser keeps the actual paragraph layout while earlier turns are inserted above the reading position. ".repeat(
              12
            ),
          },
        ],
      },
    ],
  }))
  flushSync(() =>
    root.render(
      <div className="flex h-96 flex-col" style={{ width: 640 }}>
        <ConversationTimeline
          identity="geometry-check"
          exchanges={exchanges}
          empty={null}
        />
      </div>
    )
  )
  const scroller = fixture.querySelector<HTMLDivElement>(
    ".scroll-fade-scroller"
  )!
  // Open the thread fully before measuring a user's established reading position.
  await new Promise((resolve) => setTimeout(resolve, 300))
  scroller.dispatchEvent(
    new WheelEvent("wheel", { deltaY: -100, bubbles: true })
  )
  scroller.scrollTop = 0
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const anchor = fixture.querySelector<HTMLElement>(
    '[data-exchange="exchange-30"]'
  )!
  const offset = () =>
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const before = offset()
  // Reaching the top asks for the earlier turns by itself; no control to press.
  await until(
    () => fixture.querySelector('[data-exchange="exchange-0"]') !== null
  )
  await new Promise((resolve) => setTimeout(resolve, 160))
  check(
    Math.abs(offset() - before) <= 2,
    `prepending thirty real exchanges preserves the reading anchor within 2px (${Math.abs(offset() - before).toFixed(2)}px)`
  )
  check(
    fixture.querySelector('[data-earlier="start"]') !== null,
    "the beginning of the conversation is marked once nothing earlier remains"
  )
  const paragraph = fixture.querySelector("[data-preserve-height] p")!
  check(
    getComputedStyle(paragraph).contentVisibility === "visible",
    "paragraph estimates yield to the transcript's scroll-preservation guard"
  )
}

async function clipboard() {
  const bridge = window.mako!
  const original = bridge.copy
  const source = (text: string) => (
    <>
      <Prose text={`\`\`\`text\n${text}\n\`\`\``} />
      <Toaster />
    </>
  )
  try {
    const pending = deferred()
    bridge.copy = () => pending.promise
    flushSync(() => root.render(source("first")))
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    check(
      !fixture.textContent?.includes("Copied"),
      "copy is not confirmed while the clipboard is pending"
    )
    pending.resolve()
    await until(() => Boolean(fixture.textContent?.includes("Copied")))
    check(true, "copy confirms after the clipboard succeeds")
    const label = fixture.querySelector(".changing-label")!
    check(
      getComputedStyle(label).animationName ===
        (matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "none"
          : "label-arrive"),
      "label motion uses the production stylesheet and respects reduced motion"
    )

    const stale = deferred()
    bridge.copy = () => stale.promise
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    flushSync(() => root.render(source("different text")))
    stale.resolve()
    await new Promise((resolve) => setTimeout(resolve, 40))
    check(
      !fixture.textContent?.includes("Copied"),
      "a stale copy cannot confirm replacement text"
    )

    bridge.copy = () => Promise.reject(new Error("fixture clipboard refusal"))
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    await until(() => Boolean(fixture.textContent?.includes("Could not copy")))
    check(
      !fixture.textContent?.includes("Copied"),
      "clipboard refusal never reports success"
    )
    check(
      Boolean(fixture.textContent?.includes("Retry")),
      "clipboard failure offers retry"
    )
    await new Promise((resolve) => setTimeout(resolve, 4200))
    check(
      Boolean(fixture.textContent?.includes("Could not copy")),
      "actionable failure survives the default toast timeout"
    )
    bridge.copy = () => Promise.resolve()
    fixture
      .querySelector<HTMLButtonElement>("[aria-label='Copy code']")!
      .click()
    await until(
      () =>
        Boolean(fixture.textContent?.includes("Copied")) &&
        !fixture.textContent?.includes("Could not copy")
    )
    check(true, "a successful retry clears the obsolete failure")
  } finally {
    bridge.copy = original
  }
}

async function divider() {
  let resized = 300
  let committed = 300
  flushSync(() =>
    root.render(
      <Divider
        side="right"
        size={300}
        min={200}
        max={500}
        onResize={(value) => {
          resized = value
        }}
        onCommit={(value) => {
          committed = value
        }}
      />
    )
  )
  const handle = fixture.querySelector<HTMLElement>("[role=separator]")!
  handle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })
  )
  check(
    resized === 310 && committed === 310,
    "keyboard resize commits a ten-pixel step"
  )
  // Synthetic pointer events do not allocate a native pointer. Stub only capture;
  // the production event handlers, RAF, body cleanup and React teardown run intact.
  let captured = false
  handle.setPointerCapture = () => {
    captured = true
  }
  handle.hasPointerCapture = () => captured
  handle.releasePointerCapture = () => {
    captured = false
  }
  const cursor = document.body.style.cursor
  const selection = document.body.style.userSelect
  const pointer = { pointerId: 1, isPrimary: true, button: 0, bubbles: true }
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { ...pointer, clientX: 300 })
  )
  handle.dispatchEvent(
    new PointerEvent("pointermove", { ...pointer, clientX: 200 })
  )
  flushSync(() => root.render(null))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(
    document.body.style.cursor === cursor &&
      document.body.style.userSelect === selection &&
      !captured,
    "unmount during a drag releases capture and restores body interaction"
  )
  check(committed === 310, "unmount does not persist an unfinished drag")
}

async function reflectedLight() {
  const originalFrame = window.requestAnimationFrame
  const originalMedia = window.matchMedia
  let requests = 0
  window.requestAnimationFrame = (callback) => {
    requests++
    return originalFrame(callback)
  }
  const render = (animated: boolean) =>
    flushSync(() =>
      root.render(
        <div className="relative h-48">
          <OceanScene animated={animated} />
        </div>
      )
    )
  try {
    render(true)
    await until(() => fixture.querySelector("[data-water-moving]") !== null)
    const light = fixture.querySelector<HTMLElement>(".ocean-light")!
    const grain = fixture.querySelector<HTMLElement>(".ocean-grain")!
    const fin = fixture.querySelector<HTMLElement>(".ocean-fin")!
    const finGlint = fixture.querySelector<HTMLElement>(".ocean-fin-glint")!
    const image = fixture.querySelector<HTMLImageElement>(".ocean-engraving")!
    await until(() => image.complete && image.naturalWidth > 0)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const imageBounds = () => {
      const rect = image.getBoundingClientRect()
      const pane = fixture.getBoundingClientRect()
      return [
        rect.left - pane.left,
        rect.top - pane.top,
        rect.width,
        rect.height,
      ]
    }
    const bounds = imageBounds()
    const reflection = light.querySelector<HTMLImageElement>("img")!
    const reflectionAligned = () => {
      const original = image.getBoundingClientRect()
      const reflected = reflection.getBoundingClientRect()
      return [
        original.x - reflected.x,
        original.y - reflected.y,
        original.width - reflected.width,
        original.height - reflected.height,
      ].every((delta) => Math.abs(delta) < 0.1)
    }
    check(
      reflectionAligned(),
      "the counter-moving reflection aligns with the engraving"
    )
    const first = getComputedStyle(light).transform
    const firstGrain = getComputedStyle(grain).transform
    const firstFin = getComputedStyle(finGlint).transform
    await new Promise((resolve) => setTimeout(resolve, 450))
    check(
      getComputedStyle(light).transform !== first,
      "reflected light visibly advances through its CSS animation"
    )
    check(
      getComputedStyle(grain).transform !== firstGrain,
      "the dithered atmosphere drifts independently of the engraving"
    )
    check(
      getComputedStyle(finGlint).transform !== firstFin &&
        getComputedStyle(finGlint).animationDuration !==
          getComputedStyle(light).animationDuration,
      "the fin has its own moving dither with an independent period"
    )
    check(
      reflectionAligned(),
      "reflection lines remain aligned while the mask travels"
    )
    const finRect = fin.getBoundingClientRect()
    const engravingRect = image.getBoundingClientRect()
    check(
      [
        finRect.x - engravingRect.x,
        finRect.y - engravingRect.y,
        finRect.width - engravingRect.width,
        finRect.height - engravingRect.height,
      ].every((delta) => Math.abs(delta) < 0.1) &&
        getComputedStyle(fin).maskPosition === "50% 100%" &&
        getComputedStyle(fin).maskSize === "cover",
      "the fin overlay shares the engraving's dimensions and bottom-aligned crop"
    )
    check(
      imageBounds().every(
        (value, index) => Math.abs(value - bounds[index]!) < 0.1
      ),
      `the engraving stays stationary throughout the light animation (${imageBounds()
        .map((value, index) => (value - bounds[index]!).toFixed(2))
        .join(", ")})`
    )
    check(
      !fixture.querySelector("canvas"),
      "the generated-dot canvas is removed"
    )
    check(
      requests === 0,
      "reflected light schedules zero JavaScript animation frames"
    )

    const sweep = light.getAnimations()[0]!
    const savedTime = sweep.currentTime
    sweep.pause()
    // Account for the -1.5s phase offset at both ends of the round trip.
    for (const boundary of [4500, 10500]) {
      sweep.currentTime = boundary - 10
      const before = getComputedStyle(light).transform
      sweep.currentTime = boundary + 10
      check(
        getComputedStyle(light).transform === before,
        `the reflection crosses its ${boundary}ms loop boundary without jumping`
      )
    }
    sweep.currentTime = savedTime
    sweep.play()

    const shimmer = finGlint.getAnimations()[0]!
    const savedFinTime = shimmer.currentTime
    shimmer.pause()
    for (const boundary of [3700, 8200]) {
      shimmer.currentTime = boundary - 10
      const before = getComputedStyle(finGlint).transform
      shimmer.currentTime = boundary + 10
      check(
        getComputedStyle(finGlint).transform === before,
        `the fin crosses its ${boundary}ms loop boundary without jumping`
      )
    }
    shimmer.currentTime = savedFinTime
    shimmer.play()

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))
    check(
      getComputedStyle(light).animationPlayState === "paused",
      "hiding the document immediately pauses reflected light"
    )
    check(
      getComputedStyle(grain).animationPlayState === "paused",
      "hiding the document also pauses the dithered atmosphere"
    )
    check(
      getComputedStyle(finGlint).animationPlayState === "paused",
      "hiding the document pauses the fin shimmer too"
    )
    Reflect.deleteProperty(document, "hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    await until(() => fixture.querySelector("[data-water-moving]") !== null)

    fixture.style.display = "none"
    await until(() => fixture.querySelector("[data-water-moving]") === null)
    check(
      getComputedStyle(light).animationPlayState === "paused",
      "covered or offscreen artwork stops animating"
    )
    fixture.style.removeProperty("display")
    await until(() => fixture.querySelector("[data-water-moving]") !== null)

    render(false)
    await until(() => fixture.querySelector("[data-water-moving]") === null)
    check(
      getComputedStyle(light).animationPlayState === "paused",
      "the still treatment disables reflected light"
    )
    check(
      getComputedStyle(grain).animationPlayState === "paused",
      "the motion preference stops both animated layers"
    )
    flushSync(() => root.render(null))
    window.matchMedia = (query) => {
      const media = originalMedia.call(window, query)
      if (query === "(prefers-reduced-motion: reduce)")
        Object.defineProperty(media, "matches", { value: true })
      return media
    }
    render(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    check(
      !fixture.querySelector("[data-water-moving]"),
      "reduced motion keeps the engraving still"
    )
    flushSync(() => root.render(null))
    check(
      requests === 0,
      "unmount leaves no JavaScript animation loop to clean up"
    )
  } finally {
    fixture.style.removeProperty("display")
    Reflect.deleteProperty(document, "hidden")
    window.matchMedia = originalMedia
    window.requestAnimationFrame = originalFrame
  }
}

button.onclick = async () => {
  button.disabled = true
  output.textContent = "Running production UI checks…"
  try {
    await openingDraft()
    await paragraphs()
    await transcriptAnchor()
    await clipboard()
    await divider()
    await reflectedLight()
    output.textContent += "\n\nAll UI regression checks passed."
  } catch (error) {
    output.textContent += `\nFAIL ${error instanceof Error ? error.message : String(error)}`
  } finally {
    flushSync(() => root.render(null))
    button.disabled = false
  }
}
