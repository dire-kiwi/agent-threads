import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@dire-kiwi/agent-threads-react/styles.css";
import "./app.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
