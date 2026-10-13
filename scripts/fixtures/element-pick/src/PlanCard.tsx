type PlanCardProps = {
  name: string
  price: string
  primary: boolean
}

export function PlanCard({ name, price, primary }: PlanCardProps) {
  const label: string = primary ? "Start a trial" : "Get started"
  return (
    <article className="card" aria-label={`${name} plan`}>
      <h2>{name}</h2>
      <p className="price">{price}</p>
      <button type="button" className={primary ? "cta" : "cta secondary"}>
        {label}
      </button>
    </article>
  )
}
