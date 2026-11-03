// Explicit isolated fixture for the live mark; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "./harness-fixtures"
import { Bench, Legend } from "./live-marks-fixture"
import { MARK_STATES } from "./live-marks-states"
import "../index.css"

/*
 * Every state of the live mark as a rail row wears it, lit and not, at the rail's 20 px and the phone's 28 px, for
 * `test-live-marks-ui.mjs`. `?theme=light` draws it light. `?still=<ms>` stops every animation at that point of the
 * shared clock, for screenshots and filmstrips. `?bench=<n>` draws n rows in a scroller, almost all of them moving,
 * for the render-cost bench (`&state=` fills every row with one state): `window.liveMarkBench()` counts the animations
 * running and paused.
 */

const search = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", search.get("theme") === "light")
threadsStore.set({ descriptors: fixtureHarnesses })

Reflect.set(window, "liveMarkBench", () => {
  const animations = document.getAnimations()
  return {
    animations: animations.length,
    running: animations.filter((animation) => animation.playState === "running").length,
    paused: animations.filter((animation) => animation.playState === "paused").length,
  }
})

const bench = Number(search.get("bench") ?? 0)
const only = MARK_STATES.find((state) => state === search.get("state"))
createRoot(document.getElementById("root")!).render(<div className="min-h-dvh bg-shell text-foreground">{bench ? <Bench count={bench} only={only} /> : <Legend />}</div>)

const still = search.get("still")
if (still !== null)
  setTimeout(() => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = Number(still)
    }
    document.documentElement.dataset.still = still
  }, 600)
