// SPDX-License-Identifier: AGPL-3.0-or-later
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { registerServiceWorker } from "./push.js";

// Register the Web Push service worker exactly once per app load.
// Idempotent, permission-neutral (never prompts here) — the browser
// dedupes by scope and the SW itself only ever activates the push
// handler; no offline caching, deliberately.
registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);