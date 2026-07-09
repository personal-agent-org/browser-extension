import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  {
    // Security hygiene: forbid eval/implied-eval everywhere; the one intentional page eval in
    // browser_eval_js carries a targeted eslint-disable so new accidental uses still get caught.
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
  {
    // Extension runtime: service worker + injected/page code + WebExtension namespaces.
    files: ["background.js", "tools.js", "cdp.js", "platform.js", "urls.js", "meeting.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.serviceworker, ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Meeting capture: content script + adapters + page inject + offscreen document. These run in
    // page/content/offscreen contexts with DOM + WebExtension + Web Audio globals.
    files: ["content-meeting.js", "offscreen.js", "meeting/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // The AudioWorklet processor runs in AudioWorkletGlobalScope (no window/DOM).
    files: ["meeting/pcm-worklet.js"],
    languageOptions: {
      globals: {
        registerProcessor: "readonly",
        AudioWorkletProcessor: "readonly",
        sampleRate: "readonly",
        currentTime: "readonly",
      },
    },
  },
  {
    // Popup runs in a normal extension document.
    files: ["popup.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Build script, ESLint config and the test suite run under Node.
    files: ["build.mjs", "eslint.config.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
