import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./lib/toast";
import "./styles/style.css";
import "./styles/pages.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary title="The application failed to load.">
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);