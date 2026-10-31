// Every story inside the theme preset Ladle's theme switch picks.
import type { GlobalProvider } from "@ladle/react";
import "../src/styles.css";

export const Provider: GlobalProvider = ({ children, globalState }) => {
  const dark = globalState.theme === "dark" || (globalState.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <div className={dark ? "at-theme-dark" : "at-theme-light"} style={{ background: "var(--at-bg)", color: "var(--at-fg)", minHeight: "100vh", padding: "1rem", boxSizing: "border-box" }}>
      {children}
    </div>
  );
};
