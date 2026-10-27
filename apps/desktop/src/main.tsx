import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@review-pinger/app";
import "@review-pinger/app/styles.css";
import { NotificationCard } from "./components/NotificationCard";
import { tauriPlatform } from "./tauriPlatform";

// The notification card is its own window, served from the same page.
const isCard = location.search === "?card";

// The card is frameless on every platform, so only the popover needs this.
if (!isCard && navigator.userAgent.includes("Linux")) {
  document.documentElement.classList.add("native-frame");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCard ? <NotificationCard /> : <App platform={tauriPlatform} />}
  </React.StrictMode>,
);
