import React from "react";
import "./index.css";
import ReactDOM from "react-dom/client";
import App from "./App";
import { NotificationCard } from "./components/NotificationCard";

// The notification card is its own window, served from the same page.
const isCard = location.search === "?card";

// The card is frameless on every platform, so only the popover needs this.
if (!isCard && navigator.userAgent.includes("Linux")) {
  document.documentElement.classList.add("native-frame");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isCard ? <NotificationCard /> : <App />}</React.StrictMode>,
);
