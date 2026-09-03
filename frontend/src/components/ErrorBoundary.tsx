/**
 * ErrorBoundary
 *
 * React only stops an uncaught render/lifecycle error from taking down
 * the ENTIRE app if something upstream is a class-component error
 * boundary (there is no hook equivalent as of React 18/19) -- without
 * one, any single component throwing during render blanks the whole
 * page to white, with nothing shown to the user except the browser
 * console.
 *
 * This app previously had no error boundary anywhere in its render
 * tree. Two are wired in (see App.tsx):
 *   1. One around the entire <App /> in main.tsx -- catches anything
 *      catastrophic (a crash in the sidebar/shell itself).
 *   2. One around the <Routes> outlet in App.tsx -- catches a crash in
 *      a single page while keeping the sidebar/nav usable, so the user
 *      can navigate to a different page instead of reloading.
 *
 * Deliberately a class component: componentDidCatch/getDerivedStateFromError
 * are the only React APIs that can intercept a render-phase error from a
 * descendant. It does NOT catch: errors in event handlers (those already
 * throw to the browser console without unmounting anything), errors in
 * async code (fetch/promise rejections -- those are handled by each
 * page's own try/catch and surfaced via Banner/toast), or server-side
 * rendering errors (this app has none).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown above the retry button; defaults to a generic message. */
  title?: string;
  /** If provided, rendered instead of the default fallback UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged for now; if/when this app wires up a remote error-reporting
    // service, this is the one place that needs to change to also send
    // render-phase crashes there (fetch/API errors already flow through
    // apiCall's own logging separately).
    console.error("ErrorBoundary caught a render error:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div
        style={{
          margin: "40px auto",
          maxWidth: "560px",
          padding: "28px",
          textAlign: "center",
        }}
      >
        <div
          className="error-banner"
          style={{ textAlign: "left", marginBottom: "16px" }}
        >
          <strong>{this.props.title || "Something went wrong."}</strong>
          <div style={{ marginTop: "6px", opacity: 0.85 }}>
            {error.message || "An unexpected error occurred while rendering this page."}
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            Try Again
          </button>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload Page
          </button>
        </div>
      </div>
    );
  }
}
