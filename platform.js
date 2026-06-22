// Cross-browser WebExtension shim: `browser ?? chrome` yields the promise-based API namespace on
// both Firefox and Chrome, so the rest of the code can use `await api.xxx(...)`.
export const api = globalThis.browser ?? globalThis.chrome;

// Chrome DevTools Protocol (chrome.debugger) — Chromium-only; gates the debug-mode tools.
export const HAS_DEBUGGER = !!api.debugger;

export function engineName() {
  const ua = (globalThis.navigator?.userAgent || "").toLowerCase();
  if (ua.includes("firefox")) return "Firefox";
  if (ua.includes("edg/")) return "Edge";
  return "Chrome";
}
