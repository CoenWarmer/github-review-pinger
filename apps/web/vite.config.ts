import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  // Relative, so the site works from any path, such as GitHub Pages' /repo-name/.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    // The shared UI imports itself through `@/`, which resolves to its sources.
    alias: { "@": path.resolve(import.meta.dirname, "../../packages/app/src") },
  },
});
