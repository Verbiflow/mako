import { useState } from "react"
import { PlanCard } from "./PlanCard.tsx"

interface Plan {
  name: string
  price: string
  primary: boolean
}

const plans: Plan[] = [
  { name: "Starter", price: "$0", primary: false },
  { name: "Team", price: "$24", primary: true },
]

/** The page counts every click it receives, so a test can tell a picked click never reached it. */
export function App() {
  const [clicks, setClicks] = useState(0)
  return (
    <main onClick={() => setClicks((count) => count + 1)}>
      <h1 data-testid="headline">Choose a plan</h1>
      <section className="plans">
        {plans.map((plan) => (
          <PlanCard key={plan.name} name={plan.name} price={plan.price} primary={plan.primary} />
        ))}
      </section>
      <p id="clicks">Clicks received: {clicks}</p>
    </main>
  )
}
