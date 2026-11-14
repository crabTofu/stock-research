import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "theme";
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme in effect: the user's explicit choice, else the OS setting. */
export function currentTheme(): Theme {
  return stored() ?? (mq.matches ? "dark" : "light");
}

function apply() {
  document.documentElement.dataset.theme = currentTheme();
  listeners.forEach((f) => f());
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: still applies for this session */
  }
  document.documentElement.dataset.theme = t;
  listeners.forEach((f) => f());
}

// follow OS changes until the user has picked explicitly
mq.addEventListener("change", () => {
  if (!stored()) apply();
});

export function useTheme(): Theme {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => (document.documentElement.dataset.theme as Theme) || currentTheme(),
  );
}
