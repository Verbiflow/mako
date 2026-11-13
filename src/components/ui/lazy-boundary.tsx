import { Component, type ReactNode } from "react"

/**
 * Around a piece read with `React.lazy`: an import that fails throws where the piece renders, and without a boundary of
 * its own that reaches the window's, which replaces the whole window with its error screen. This draws `fallback` in
 * the piece's place instead; `retry` clears it, for a caller that offers to read the piece again.
 */
interface LazyBoundaryProps {
  fallback: (retry: () => void) => ReactNode
  onRetry?: () => void
  children: ReactNode
}

interface LazyBoundaryState {
  failed: boolean
}

export class LazyBoundary extends Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { failed: false }

  static getDerivedStateFromError(): LazyBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    console.warn("[mako] a piece of the window couldn't load", error)
  }

  retry = (): void => {
    this.props.onRetry?.()
    this.setState({ failed: false })
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children
  }
}
