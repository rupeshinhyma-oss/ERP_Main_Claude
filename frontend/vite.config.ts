import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    // The backend runs separately (default http://localhost:8000). Requests to
    // /api/v1 are proxied so the browser sees one origin and CORS is a non-issue.
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8001",
        changeOrigin: true,
      },
    },
  },
});
