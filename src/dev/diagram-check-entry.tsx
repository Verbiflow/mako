import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Fixture } from "./diagram-check"

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
