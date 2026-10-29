import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// The workspace version in Cargo.toml, which a release bumps with the others.
const version =
  /^version = "(.+)"$/m.exec(
    readFileSync(path.resolve(import.meta.dirname, "../../Cargo.toml"), "utf8"),
  )?.[1] ?? "unknown";

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  define: { __APP_VERSION__: JSON.stringify(version) },

  resolve: {
    // The shared UI imports itself through `@/`, which resolves to its sources.
    alias: { "@": path.resolve(import.meta.dirname, "../../packages/app/src") },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
