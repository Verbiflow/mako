import { createRoot } from "react-dom/client"
import { Desk, Notice, Phone } from "./github-person-fixtures"

const view = new URLSearchParams(location.search).get("view")
createRoot(document.getElementById("root")!).render(view === "phone" ? <Phone /> : view === "desk" ? <Desk /> : <Notice />)
