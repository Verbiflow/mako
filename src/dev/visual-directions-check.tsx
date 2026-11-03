// Explicit isolated fixture: three visual directions for the person to pick from; never imported by the app.
import { createRoot } from "react-dom/client"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "./harness-fixtures"
import { DeskBoard, PhoneBoard, StatesBoard } from "./visual-directions"
import "../index.css"
import "./visual-directions.css"

/*
 * `?dir=a|b|c` picks a direction, `&board=desk|phone|states`, `&theme=light`, `&still=<ms>` stops every animation at
 * that point for screenshots and frame strips.
 */
const search = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", search.get("theme") === "light")
threadsStore.set({ descriptors: fixtureHarnesses })
const dir = search.get("dir") === "b" ? "b" : search.get("dir") === "c" ? "c" : "a"
const board = search.get("board")
createRoot(document.getElementById("root")!).render(
  <div className="min-h-dvh bg-shell text-foreground">
    {board === "phone" ? <PhoneBoard dir={dir} /> : board === "states" ? <StatesBoard dir={dir} /> : <DeskBoard dir={dir} />}
  </div>
)

const still = search.get("still")
if (still !== null)
  setTimeout(() => {
    for (const animation of document.getAnimations()) {
      animation.pause()
      animation.currentTime = Number(still)
    }
    document.documentElement.dataset.still = still
  }, 600)
