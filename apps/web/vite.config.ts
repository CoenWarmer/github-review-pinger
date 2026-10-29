import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

// The workspace version in Cargo.toml, which a release bumps with the others.
const version =
  /^version = "(.+)"$/m.exec(
    readFileSync(path.resolve(import.meta.dirname, "../../Cargo.toml"), "utf8"),
  )?.[1] ?? "unknown";

export default defineConfig({
  // Relative, so the site works from any path, such as GitHub Pages' /repo-name/.
  base: "./",
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    // The shared UI imports itself through `@/`, which resolves to its sources.
    alias: { "@": path.resolve(import.meta.dirname, "../../packages/app/src") },
  },
});
