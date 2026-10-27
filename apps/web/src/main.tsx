import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@review-pinger/app";
import "@review-pinger/app/styles.css";
import { loadPinger } from "@review-pinger/wasm";
import { Engine } from "./engine.ts";
import { createGithub } from "./github.ts";
import { queries } from "./queries.ts";
import { createWebPlatform } from "./webPlatform.ts";
import "./web.css";

// A page, not a popover: no rounded window frame.
document.documentElement.classList.add("native-frame");

const engine = new Engine({
  storage: {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
  },
  loadPinger,
  createGithub: (token) => createGithub({ token, queries }),
});

document.addEventListener("visibilitychange", () => {
  engine.setVisible(document.visibilityState === "visible");
});
void engine.start();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App platform={createWebPlatform(engine)} />
  </React.StrictMode>,
);

// Lets the page install and open without a network.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
