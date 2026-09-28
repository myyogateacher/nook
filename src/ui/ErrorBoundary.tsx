import { Component, type ErrorInfo, type ReactNode } from "react";

/** The card shown instead of a blank page when rendering throws. The message is shown in development only. */
export function CrashCard({ message, onReload }: { message?: string; onReload: () => void }) {
  return <main className="auth-page crash-page">
    <section className="auth-card crash-card" role="alert" aria-labelledby="crash-heading">
      <div className="auth-heading">
        <span className="eyebrow">Nook</span>
        <h1 id="crash-heading">Something went wrong</h1>
        <p>Nook hit an unexpected error. Reload the page to continue; your saved work is safe.</p>
        {message && <pre className="crash-detail">{message}</pre>}
      </div>
      <button type="button" className="primary-button" onClick={onReload}>Reload</button>
    </section>
  </main>;
}

type Props = { children: ReactNode; showDetails?: boolean; onReload?: () => void };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Nook crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const showDetails = this.props.showDetails ?? Boolean(import.meta.env?.DEV);
    return <CrashCard message={showDetails ? this.state.error.message : undefined} onReload={this.props.onReload ?? (() => window.location.reload())} />;
  }
}
