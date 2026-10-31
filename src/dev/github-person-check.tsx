import { createRoot } from "react-dom/client"
import { Notice, Phone, phoneView } from "./github-person-fixtures"

createRoot(document.getElementById("root")!).render(phoneView ? <Phone /> : <Notice />)
