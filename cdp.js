// Chrome DevTools Protocol (CDP) layer for the browser device — the "debug mode" the assistant
// can switch a tab into for capabilities the plain DOM path can't reach:
//   • TRUSTED input  — Input.dispatch* events carry isTrusted=true, so sites that ignore
//     synthetic clicks/keystrokes (React-controlled inputs, canvas apps, drag-drop) still react.
//   • Accessibility tree — Accessibility.getFullAXTree gives a compact, role+name labelled view
//     of the page that is far more reliable (and token-cheap) for grounding than raw innerText.
//   • Console + network capture — Runtime/Log/Network events are buffered so the assistant can
//     SEE JS errors and requests, i.e. actually debug a page.
//   • Full-page screenshots — Page.captureScreenshot(captureBeyondViewport) beyond the viewport.
//
// Attaching shows Chrome's "Personal Agent started debugging this browser" banner; the
// user can end it any time via the banner's Cancel (→ onDetach cleans up here). We attach LAZILY
// (only when a debug tool is used) and stay attached until the tab closes or the user cancels, so
// a user who never invokes a debug tool sees zero change. State is in-memory: if the MV3 service
// worker is torn down Chrome auto-detaches and the buffers reset; the next debug call re-attaches.

import { api, HAS_DEBUGGER } from "./platform.js";

// chrome.debugger (Chromium-only). On Firefox this is undefined and every export below becomes
// inert: supported()/isAttached() report false, ensureAttached() throws a clear error, and the
// event listeners are never registered — so this module is safe to load in a Firefox build.
const debuggerApi = api.debugger;

const PROTOCOL = "1.3";
const CONSOLE_CAP = 120; // ring-buffer sizes — bound memory + the rpc_result frame size
const NETWORK_CAP = 200;

// tabId -> true once we've attached + enabled domains.
const attached = new Map();
// tabId -> { console: [...], network: [...], byId: Map<requestId, entry> }
const buffers = new Map();

function buf(tabId) {
  let b = buffers.get(tabId);
  if (!b) {
    b = { console: [], network: [], byId: new Map() };
    buffers.set(tabId, b);
  }
  return b;
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// ---------- command wrapper ----------
function send(tabId, method, params = {}) {
  // MV3 debugger.sendCommand returns a Promise that rejects on protocol error.
  return debuggerApi.sendCommand({ tabId }, method, params);
}

// ---------- attach / detach lifecycle ----------
// Whether this browser has the DevTools Protocol at all (false on Firefox). Callers use it to
// decide whether to announce / attempt the debug-mode tools.
export function supported() {
  return HAS_DEBUGGER;
}

export function isAttached(tabId) {
  return HAS_DEBUGGER && attached.get(tabId) === true;
}

async function attach(tabId) {
  try {
    await debuggerApi.attach({ tabId }, PROTOCOL);
  } catch (e) {
    // Already attached by us on a previous call is fine; anything else (DevTools open on the
    // tab, a restricted chrome:// / web-store page) is surfaced to the caller verbatim.
    if (!/already attached/i.test(e?.message || "")) throw e;
  }
  attached.set(tabId, true);
  buffers.set(tabId, { console: [], network: [], byId: new Map() });
  // Enable the always-on domains; Accessibility is enabled lazily (it's heavier) in axTree().
  await Promise.all([
    send(tabId, "Page.enable"),
    send(tabId, "Runtime.enable"),
    send(tabId, "Log.enable"),
    send(tabId, "Network.enable"),
    send(tabId, "DOM.enable"),
  ]);
}

// Attach if needed. Returns { justAttached } so a reader tool can tell the model that capture
// only started now (console/network are forward-looking: CDP has no backlog before attach).
export async function ensureAttached(tabId) {
  if (!HAS_DEBUGGER) {
    throw new Error("debug mode (DevTools Protocol) is not supported in this browser");
  }
  if (isAttached(tabId)) return { justAttached: false };
  await attach(tabId);
  return { justAttached: true };
}

export async function detach(tabId) {
  attached.delete(tabId);
  buffers.delete(tabId);
  try {
    await debuggerApi.detach({ tabId });
  } catch {
    /* already gone */
  }
}

function forget(tabId) {
  attached.delete(tabId);
  buffers.delete(tabId);
}

// ---------- event capture (registered once at SW load) ----------
function fmtArg(o) {
  if (!o) return "";
  if (Object.prototype.hasOwnProperty.call(o, "value")) {
    return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  }
  if (o.unserializableValue) return String(o.unserializableValue);
  if (o.description) return o.description;
  return o.type || "";
}

function captureEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId == null || !attached.get(tabId)) return;
  const b = buf(tabId);
  try {
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || []).map(fmtArg).join(" ").slice(0, 1000);
      pushCapped(b.console, { level: params.type || "log", text, ts: params.timestamp }, CONSOLE_CAP);
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      const text = (d.exception?.description || d.text || "uncaught exception").slice(0, 1000);
      pushCapped(b.console, { level: "error", text, ts: params.timestamp }, CONSOLE_CAP);
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {};
      pushCapped(
        b.console,
        { level: e.level || "info", text: (e.text || "").slice(0, 1000), source: e.source },
        CONSOLE_CAP,
      );
    } else if (method === "Network.requestWillBeSent") {
      const r = params.request || {};
      const entry = {
        id: params.requestId,
        method: r.method,
        url: r.url,
        type: params.type,
        status: null,
        mime: null,
        failed: null,
      };
      pushCapped(b.network, entry, NETWORK_CAP);
      b.byId.set(params.requestId, entry);
    } else if (method === "Network.responseReceived") {
      const e = b.byId.get(params.requestId);
      if (e) {
        e.status = params.response?.status ?? e.status;
        e.mime = params.response?.mimeType ?? e.mime;
        e.type = params.type || e.type;
      }
    } else if (method === "Network.loadingFailed") {
      const e = b.byId.get(params.requestId);
      if (e) e.failed = params.errorText || "failed";
    }
  } catch {
    /* never let a capture hiccup break the debugger session */
  }
}

// Register the debugger + cleanup listeners only where the DevTools Protocol exists (Chromium).
// On Firefox debuggerApi is undefined, so these are skipped and the module stays inert.
if (HAS_DEBUGGER) {
  debuggerApi.onEvent.addListener(captureEvent);
  // User clicked the banner's Cancel, the tab closed, or another debugger took over.
  debuggerApi.onDetach.addListener((source) => {
    if (source.tabId != null) forget(source.tabId);
  });
  api.tabs.onRemoved.addListener((tabId) => {
    if (attached.has(tabId)) detach(tabId);
  });
}

// ---------- readers ----------
export function getConsole(tabId, { limit = 40, level } = {}) {
  const b = buffers.get(tabId);
  if (!b) return [];
  let rows = b.console;
  if (level) rows = rows.filter((r) => r.level === level);
  return rows.slice(-Math.max(1, Math.min(limit, CONSOLE_CAP))).map((r) => ({
    level: r.level,
    text: r.text,
    ...(r.source ? { source: r.source } : {}),
  }));
}

export function getNetwork(tabId, { limit = 40, filter } = {}) {
  const b = buffers.get(tabId);
  if (!b) return [];
  let rows = b.network;
  if (filter) {
    const q = String(filter).toLowerCase();
    rows = rows.filter((r) => (r.url || "").toLowerCase().includes(q));
  }
  return rows.slice(-Math.max(1, Math.min(limit, NETWORK_CAP))).map((r) => ({
    id: r.id,
    method: r.method,
    status: r.failed ? "FAILED" : r.status,
    type: r.type,
    url: (r.url || "").slice(0, 300),
    ...(r.failed ? { error: r.failed } : {}),
  }));
}

export async function responseBody(tabId, requestId) {
  const r = await send(tabId, "Network.getResponseBody", { requestId });
  const body = r?.base64Encoded ? atob(r.body || "") : r?.body || "";
  return body.slice(0, 4000);
}

// ---------- accessibility snapshot ----------
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "option",
  "spinbutton", "textarea",
]);

export async function axTree(tabId, limit = 60) {
  await send(tabId, "Accessibility.enable");
  const { nodes } = await send(tabId, "Accessibility.getFullAXTree");
  const cap = Math.max(1, Math.min(limit, 200));
  const out = [];
  for (const n of nodes || []) {
    if (n.ignored) continue;
    const role = n.role?.value;
    const name = (n.name?.value || "").trim();
    if (!role) continue;
    if (!name && !INTERACTIVE.has(role)) continue; // keep named OR interactive nodes
    const row = { ref: n.backendDOMNodeId, role, name: name.slice(0, 120) };
    const value = n.value?.value;
    if (value != null && value !== "") row.value = String(value).slice(0, 120);
    if (row.ref != null) out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

// Viewport-space centre (CSS px) of an a11y node, for a trusted click by ref. Scrolls it into
// view first so an off-screen ref still lands on the element.
export async function boxCenterForRef(tabId, backendNodeId) {
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    /* not scrollable / detached — try the box anyway */
  }
  const { model } = await send(tabId, "DOM.getBoxModel", { backendNodeId });
  const q = model?.content;
  if (!q || q.length < 8) return null;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// ---------- trusted input ----------
export async function clickAt(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  const base = { x, y, button: "left", buttons: 1, clickCount: 1 };
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

export async function insertText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
};

export async function dispatchKey(tabId, key) {
  // A keyDown that carries `text` already produces the character (matches Puppeteer); a separate
  // 'char' event would double it (e.g. two newlines for Enter in a textarea).
  const k = KEYS[key] || { key, code: key, windowsVirtualKeyCode: 0 };
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
}

// ---------- full-page screenshot ----------
export async function fullScreenshot(tabId) {
  await send(tabId, "Page.enable");
  const r = await send(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 60,
    captureBeyondViewport: true,
  });
  return "data:image/jpeg;base64," + (r?.data || "");
}
