import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RailAppMarkPage } from "./rail-app-mark-check"
import "../index.css"

const light = new URLSearchParams(location.search).get("theme") === "light"
document.documentElement.classList.toggle("light", light)
document.documentElement.style.colorScheme = light ? "light" : "dark"
createRoot(document.getElementById("root")!).render(<StrictMode><RailAppMarkPage /></StrictMode>)
