import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Gallery } from "./app-chip-check"

if (new URLSearchParams(location.search).has("light")) document.documentElement.classList.add("light")
createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>)
