// Browser tool handlers + their announced specs. Each handler runs against the agent's TARGET
// tab via chrome.scripting; results are returned as strings (JSON where structured), matching
// the device RPC contract (rpc_result.result is a string).
//
// Some tools opt into "debug mode" (chrome.debugger / CDP, see cdp.js): the a11y snapshot,
// console/network capture and full-page screenshot need it, and once a tab is attached the
// click/type tools transparently upgrade to TRUSTED input events. Tabs that never touch a debug
// tool keep the plain chrome.scripting path unchanged.

import * as cdp from "./cdp.js";
import { api } from "./platform.js";

const PARAMS = {
  navigate: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL to open" } },
    required: ["url"],
  },
  get_page: {
    type: "object",
    properties: {
      max_chars: { type: "integer", description: "Cap on returned text (default 6000)" },
    },
  },
  click: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the element to click" },
      text: { type: "string", description: "Visible text to match if no selector" },
      ref: {
        type: "integer",
        description: "An element 'ref' from browser_snapshot (clicked via the debugger)",
      },
    },
  },
  type: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the input/textarea" },
      text: { type: "string", description: "Text to enter" },
      submit: { type: "boolean", description: "Press Enter after typing" },
    },
    required: ["selector", "text"],
  },
  press: {
    type: "object",
    properties: { key: { type: "string", description: "Key to press, e.g. Enter, Tab, Escape" } },
    required: ["key"],
  },
  scroll: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["down", "up", "top", "bottom"] },
      amount: { type: "integer", description: "Pixels (down/up); default one viewport" },
    },
  },
  wait_for: {
    type: "object",
    properties: {
      selector: { type: "string" },
      timeout_ms: { type: "integer", description: "Default 8000" },
    },
    required: ["selector"],
  },
  list_tabs: { type: "object", properties: {} },
  select_tab: {
    type: "object",
    properties: { tab_id: { type: "integer" } },
    required: ["tab_id"],
  },
  eval_js: {
    type: "object",
    properties: { code: { type: "string", description: "JavaScript evaluated in the page" } },
    required: ["code"],
  },
  screenshot: {
    type: "object",
    properties: {
      full_page: {
        type: "boolean",
        description: "Capture the whole scrollable page, not just the viewport (uses the debugger)",
      },
    },
  },
  snapshot: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max elements to return (default 60)" },
    },
  },
  console: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max messages to return (default 40)" },
      level: {
        type: "string",
        description: "Filter by level: log, info, warning, error, debug",
        enum: ["log", "info", "warning", "error", "debug"],
      },
    },
  },
  network: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max requests to return (default 40)" },
      filter: { type: "string", description: "Only requests whose URL contains this substring" },
      body: { type: "string", description: "A request id (from a prior call) to fetch its response body" },
    },
  },
  back: { type: "object", properties: {} },
  forward: { type: "object", properties: {} },
  reload: { type: "object", properties: {} },
  find: {
    type: "object",
    properties: {
      text: { type: "string", description: "Visible text (substring, case-insensitive) to match" },
      role: {
        type: "string",
        description: "Restrict to a kind of element: link, button, input, heading, any (default any)",
        enum: ["link", "button", "input", "heading", "any"],
      },
      limit: { type: "integer", description: "Max matches to return (default 15)" },
    },
    required: ["text"],
  },
};

// Announced to the backend in the hello frame. `write:true` tools are serialized + gated by
// the chat's security mode (approve/judge); reads run in parallel.
export const TOOL_SPECS = [
  { name: "browser_navigate", write: true, description: "Open a URL in the active tab and wait for load.", parameters: PARAMS.navigate },
  { name: "browser_get_page", write: false, description: "Return the active page's title, URL, visible text and links.", parameters: PARAMS.get_page },
  { name: "browser_click", write: true, description: "Click an element by CSS selector, visible text, or a 'ref' from browser_snapshot. In debug mode the click is a real (trusted) mouse event.", parameters: PARAMS.click },
  { name: "browser_type", write: true, description: "Type text into an input/textarea (optionally submit).", parameters: PARAMS.type },
  { name: "browser_press", write: true, description: "Press a key (Enter/Tab/Escape/…) on the focused element.", parameters: PARAMS.press },
  { name: "browser_scroll", write: true, description: "Scroll the page down/up/top/bottom.", parameters: PARAMS.scroll },
  { name: "browser_wait_for", write: false, description: "Wait until a selector appears (or timeout).", parameters: PARAMS.wait_for },
  { name: "browser_list_tabs", write: false, description: "List the open tabs (id, title, url).", parameters: PARAMS.list_tabs },
  { name: "browser_select_tab", write: true, description: "Activate a tab by id (becomes the target for later calls).", parameters: PARAMS.select_tab },
  { name: "browser_eval_js", write: true, description: "ADVANCED: evaluate JavaScript in the page's own realm and return the result.", parameters: PARAMS.eval_js },
  { name: "browser_screenshot", write: false, description: "Capture a screenshot (returned as an image you can SEE). Pass full_page:true for the whole scrollable page.", parameters: PARAMS.screenshot },
  { name: "browser_back", write: true, description: "Go back one entry in the tab's history.", parameters: PARAMS.back },
  { name: "browser_forward", write: true, description: "Go forward one entry in the tab's history.", parameters: PARAMS.forward },
  { name: "browser_reload", write: true, description: "Reload the active tab and wait for load.", parameters: PARAMS.reload },
  { name: "browser_find", write: false, description: "Find interactive/visible elements by text and return a clickable CSS selector for each (use before browser_click).", parameters: PARAMS.find },
  { name: "browser_snapshot", write: false, requiresDebugger: true, description: "DEBUG MODE: return the page's accessibility tree — a compact, labelled list of interactive elements, each with a 'ref' you can pass to browser_click. More reliable than reading raw text.", parameters: PARAMS.snapshot },
  { name: "browser_console", write: false, requiresDebugger: true, description: "DEBUG MODE: read recent console messages and JavaScript errors. Capture starts when first called; re-run the page action (or browser_reload), then read again.", parameters: PARAMS.console },
  { name: "browser_network", write: false, requiresDebugger: true, description: "DEBUG MODE: list recent network requests (method, status, type, URL); pass a request 'body' id to read a response. Capture starts when first called.", parameters: PARAMS.network },
];

// ---------- exposure + origin policy (pushed from background.js) ----------
// Tools the user disabled in Settings are neither announced nor dispatched (defense-in-depth:
// even if the backend asks for one, dispatchTool refuses it).
let disabledTools = new Set();
export function setDisabledTools(names) {
  disabledTools = new Set(Array.isArray(names) ? names : []);
}
export function announcedSpecs() {
  // Drop tools the user disabled, plus the debug-mode tools where the DevTools Protocol is
  // unavailable (e.g. Firefox) — so the backend is never offered a tool we can't serve.
  return TOOL_SPECS.filter(
    (s) => !disabledTools.has(s.name) && !(s.requiresDebugger && !cdp.supported()),
  );
}

// The agent must never drive certain origins: the Personal Agent app itself + the IdP (both
// would leak tokens/consent), plus any host the user blocks. Origins are pushed from
// background.js (config-derived). An entry matches by exact origin OR by host/subdomain.
let blockedOrigins = [];
export function setBlockedOrigins(list) {
  blockedOrigins = (Array.isArray(list) ? list : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}
function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function isBlockedUrl(url) {
  let o = "";
  try {
    o = new URL(url).origin.toLowerCase();
  } catch {
    o = "";
  }
  const h = hostOf(url);
  if (!o && !h) return false; // about:blank / chrome:// — Chrome already forbids scripting there
  for (const b of blockedOrigins) {
    const entry = b.toLowerCase();
    if (o && o === entry) return true;
    const bh = hostOf(entry.includes("://") ? entry : "https://" + entry);
    if (bh && (h === bh || h.endsWith("." + bh))) return true;
  }
  return false;
}
function assertAllowed(url) {
  if (isBlockedUrl(url)) {
    throw new Error("blocked origin (Personal Agent extension settings): " + (hostOf(url) || url));
  }
}

// The agent's target tab persists across calls so navigation/typing isn't derailed by which
// window happens to be focused (the Keycloak popup, devtools, or the extension popup).
let targetTabId = null;

async function activeTab() {
  let tab = null;
  if (targetTabId != null) {
    try {
      tab = await api.tabs.get(targetTabId);
    } catch {
      targetTabId = null;
    }
  }
  if (!tab) {
    // Prefer the last-focused NORMAL window (never devtools/popup), then any normal active tab.
    let win = null;
    try {
      win = await api.windows.getLastFocused({ windowTypes: ["normal"], populate: true });
    } catch {
      win = null;
    }
    tab = win?.tabs?.find((t) => t.active);
    if (!tab) {
      const [t] = await api.tabs.query({ active: true, windowType: "normal" });
      tab = t;
    }
    if (!tab) throw new Error("no active tab");
    targetTabId = tab.id;
  }
  // Origin guard: refuse to read/drive a protected origin even if it is the focused tab.
  if (tab.url) assertAllowed(tab.url);
  return tab;
}

// Run a function in the page (ISOLATED world: DOM access, no page JS globals).
async function inPage(tabId, func, args = []) {
  const [res] = await api.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// Run a function in the page's OWN JS realm (MAIN world) — sees window/app globals.
async function inMainWorld(tabId, func, args = []) {
  const [res] = await api.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args,
  });
  return res?.result;
}

// In-page: resolve an element by selector/text, scroll it into view, and return its viewport
// centre in CSS px (or null). Used to aim a trusted CDP mouse click in debug mode. Must be
// self-contained — it is serialized and run via api.scripting.
function locateCenter(sel, txt) {
  let el = null;
  if (sel) el = document.querySelector(sel);
  if (!el && txt) {
    const cands = Array.from(
      document.querySelectorAll("a,button,[role=button],input,textarea,select,[onclick],[role=link],[role=menuitem]"),
    );
    const q = txt.toLowerCase();
    el = cands.find((e) =>
      (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().toLowerCase().includes(q),
    );
  }
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Resolve once the tab finishes a FRESH navigation (event-driven, not status-polling — avoids
// the stale 'complete' of the previous page). No new permission (tabs covers onUpdated).
function navigateAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const onUpd = (id, info, tab) => {
      if (id === tabId && info.status === "complete" && !tab.pendingUrl) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    api.tabs.onUpdated.addListener(onUpd);
    api.tabs.update(tabId, { url }).catch(finish);
  });
}

// Wait for the NEXT load to complete (history nav / reload — no URL change to drive it).
// Returns { promise, cancel }: cancel() tears down the listener+timer when the navigation we
// were waiting for never happens (e.g. goBack rejected because there's no history entry), so a
// failed call doesn't orphan a api.tabs.onUpdated listener for the full timeout window.
function waitForComplete(tabId, timeoutMs = 15000) {
  let finish;
  const promise = new Promise((resolve) => {
    let done = false;
    finish = () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(onUpd);
      clearTimeout(timer);
      resolve();
    };
    const onUpd = (id, info, tab) => {
      if (id === tabId && info.status === "complete" && !tab.pendingUrl) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    api.tabs.onUpdated.addListener(onUpd);
  });
  return { promise, cancel: () => finish() };
}

const _settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

const HANDLERS = {
  async browser_navigate({ url }) {
    if (!url) throw new Error("url required");
    assertAllowed(url); // block navigating TO a protected origin
    const tab = await activeTab();
    await navigateAndWait(tab.id, url);
    const info = await api.tabs.get(tab.id);
    return JSON.stringify({ url: info.url, title: info.title });
  },

  async browser_get_page({ max_chars } = {}) {
    const tab = await activeTab();
    const cap = Math.max(500, Math.min(max_chars || 6000, 20000));
    const data = await inPage(
      tab.id,
      (limit) => {
        const text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, limit);
        const links = Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 60)
          .map((a) => ({ text: (a.innerText || "").trim().slice(0, 80), href: a.href }))
          .filter((l) => l.text);
        return { title: document.title, url: location.href, text, links };
      },
      [cap],
    );
    return JSON.stringify(data);
  },

  async browser_click({ selector, text, ref }) {
    const tab = await activeTab();
    // Debug mode: aim a real (trusted) mouse click at the element's centre. A `ref` comes from
    // browser_snapshot (a11y backend node id); otherwise locate by selector/text.
    if (cdp.isAttached(tab.id)) {
      let pt = null;
      // A ref (from browser_snapshot) wins; if it can't be resolved fall back to selector/text.
      if (ref != null) {
        try {
          pt = await cdp.boxCenterForRef(tab.id, ref);
        } catch {
          pt = null;
        }
      }
      if (!pt) pt = await inPage(tab.id, locateCenter, [selector || null, text || null]);
      if (!pt) throw new Error("element not found");
      await cdp.clickAt(tab.id, pt.x, pt.y);
      await _settle();
      return "clicked (trusted)";
    }
    // Plain path (no debugger attached): synthetic DOM click.
    const ok = await inPage(
      tab.id,
      (sel, txt) => {
        let el = null;
        if (sel) el = document.querySelector(sel);
        if (!el && txt) {
          const cands = Array.from(document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button]"));
          el = cands.find((e) => (e.innerText || e.value || "").trim().toLowerCase().includes(txt.toLowerCase()));
        }
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.click();
        return true;
      },
      [selector || null, text || null],
    );
    if (!ok) throw new Error("element not found");
    await _settle(); // let a click-triggered navigation / SPA render settle (status may not flip)
    return "clicked";
  },

  async browser_type({ selector, text, submit }) {
    const tab = await activeTab();
    // Debug mode: focus + select the field, then insert text as a trusted input event (so
    // framework-controlled inputs that ignore a programmatic .value still update). Enter, if
    // requested, is a real key event.
    if (cdp.isAttached(tab.id)) {
      const ok = await inPage(
        tab.id,
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          el.focus();
          if (el.select) el.select();
          return true;
        },
        [selector],
      );
      if (!ok) throw new Error("input not found");
      await cdp.insertText(tab.id, text ?? "");
      if (submit) {
        await cdp.dispatchKey(tab.id, "Enter");
        await _settle();
      }
      return "typed (trusted)";
    }
    const ok = await inPage(
      tab.id,
      (sel, val, sub) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (sub) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          if (el.form) el.form.requestSubmit?.();
        }
        return true;
      },
      [selector, text, !!submit],
    );
    if (!ok) throw new Error("input not found");
    if (submit) await _settle();
    return "typed";
  },

  async browser_press({ key }) {
    const tab = await activeTab();
    await inPage(
      tab.id,
      (k) => {
        const el = document.activeElement || document.body;
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
        }
      },
      [key],
    );
    return "pressed " + key;
  },

  async browser_scroll({ direction = "down", amount } = {}) {
    const tab = await activeTab();
    await inPage(
      tab.id,
      (dir, amt) => {
        const step = amt || window.innerHeight * 0.9;
        if (dir === "top") window.scrollTo(0, 0);
        else if (dir === "bottom") window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(0, dir === "up" ? -step : step);
      },
      [direction, amount || 0],
    );
    return "scrolled " + direction;
  },

  async browser_wait_for({ selector, timeout_ms }) {
    const tab = await activeTab();
    const found = await inPage(
      tab.id,
      async (sel, timeout) => {
        const start = Date.now();
        while (Date.now() - start < (timeout || 8000)) {
          if (document.querySelector(sel)) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      },
      [selector, timeout_ms || 8000],
    );
    return found ? "found" : "not found (timeout)";
  },

  async browser_list_tabs() {
    const tabs = await api.tabs.query({});
    return JSON.stringify(
      tabs
        .filter((t) => !isBlockedUrl(t.url || "")) // don't even reveal protected-origin tabs
        .slice(0, 40)
        .map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active })),
    );
  },

  async browser_select_tab({ tab_id }) {
    const t = await api.tabs.get(tab_id).catch(() => null);
    if (t?.url) assertAllowed(t.url); // can't pivot the target onto a protected origin
    await api.tabs.update(tab_id, { active: true });
    targetTabId = tab_id; // subsequent calls target this tab
    return "activated";
  },

  async browser_screenshot({ full_page } = {}) {
    const tab = await activeTab();
    // full_page needs the debugger (Page.captureScreenshot beyond the viewport); the default
    // viewport grab uses the plain tabs API so it works without attaching.
    if (full_page && cdp.supported()) {
      await cdp.ensureAttached(tab.id);
      return await cdp.fullScreenshot(tab.id); // data:image/jpeg;base64,...
    }
    // JPEG q60 keeps the data URL small; the backend turns the data: URL into a vision input.
    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 60,
    });
    return dataUrl; // data:image/jpeg;base64,...
  },

  async browser_back() {
    const tab = await activeTab();
    const wait = waitForComplete(tab.id);
    try {
      await api.tabs.goBack(tab.id);
    } catch {
      wait.cancel(); // no navigation happened — don't leave the listener hanging
      return "no earlier history entry";
    }
    await wait.promise;
    const info = await api.tabs.get(tab.id);
    return JSON.stringify({ url: info.url, title: info.title });
  },

  async browser_forward() {
    const tab = await activeTab();
    const wait = waitForComplete(tab.id);
    try {
      await api.tabs.goForward(tab.id);
    } catch {
      wait.cancel();
      return "no later history entry";
    }
    await wait.promise;
    const info = await api.tabs.get(tab.id);
    return JSON.stringify({ url: info.url, title: info.title });
  },

  async browser_reload() {
    const tab = await activeTab();
    const wait = waitForComplete(tab.id);
    try {
      await api.tabs.reload(tab.id);
    } catch (e) {
      wait.cancel();
      throw e;
    }
    await wait.promise;
    const info = await api.tabs.get(tab.id);
    return JSON.stringify({ url: info.url, title: info.title });
  },

  async browser_find({ text, role = "any", limit } = {}) {
    if (!text) throw new Error("text required");
    const tab = await activeTab();
    const cap = Math.max(1, Math.min(limit || 15, 50));
    const matches = await inPage(
      tab.id,
      (query, kind, max) => {
        const q = (query || "").toLowerCase();
        const sets = {
          link: "a[href]",
          button: "button,[role=button],input[type=submit],input[type=button]",
          input: "input:not([type=hidden]),textarea,select,[contenteditable=true]",
          heading: "h1,h2,h3,h4,h5,h6",
          any: "a[href],button,[role=button],input:not([type=hidden]),textarea,select,h1,h2,h3,h4,h5,h6,[onclick],[role=link],[role=menuitem]",
        };
        // CSS.escape is universal in extension content scripts; the fallback also guards a
        // leading digit (CSS requires "1foo" → "\31 foo") so a numeric id can't break a selector.
        const cssEsc = (s) => {
          if (window.CSS && CSS.escape) return CSS.escape(s);
          let out = String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
          if (/^[0-9]/.test(out)) out = "\\3" + out[0] + " " + out.slice(1);
          return out;
        };
        // Build a CSS selector and grow it (toward the root, adding :nth-of-type) until it
        // resolves to exactly ONE element — so browser_click/browser_type never mis-target a
        // sibling on deep/repetitive DOMs. Falls back to the best-effort path if nothing isolates it.
        const uniq = (sel) => document.querySelectorAll(sel).length === 1;
        const selectorFor = (el) => {
          const parts = [];
          let node = el;
          for (let depth = 0; node && node.nodeType === 1 && depth < 12; depth++) {
            // A globally-unique id anchors the whole path; a duplicate id (invalid HTML) is
            // ignored in favour of tag + :nth-of-type so siblings stay distinguishable.
            const idSel = node.id ? "#" + cssEsc(node.id) : null;
            if (idSel && uniq(idSel)) {
              parts.unshift(idSel);
              return parts.join(" > ");
            }
            let part = node.tagName.toLowerCase();
            const parent = node.parentElement;
            if (parent) {
              const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
              if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
            }
            parts.unshift(part);
            const sel = parts.join(" > ");
            if (uniq(sel)) return sel; // shortest path that isolates the element
            node = parent;
          }
          return parts.join(" > ");
        };
        const out = [];
        const seen = new Set();
        for (const el of document.querySelectorAll(sets[kind] || sets.any)) {
          const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim();
          if (q && !label.toLowerCase().includes(q)) continue;
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const visible =
            rect.width > 0 && rect.height > 0 &&
            cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0;
          if (!visible) continue;
          const sel = selectorFor(el);
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push({ tag: el.tagName.toLowerCase(), text: label.slice(0, 100), selector: sel });
          if (out.length >= max) break;
        }
        return out;
      },
      [text, role, cap],
    );
    return JSON.stringify(matches);
  },

  async browser_eval_js({ code }) {
    const tab = await activeTab();
    const out = await inMainWorld(
      tab.id,
      (src) => {
        try {
          // eslint-disable-next-line no-eval
          const r = eval(src);
          return typeof r === "string" ? r : JSON.stringify(r);
        } catch (e) {
          return "[error] " + (e && e.message ? e.message : String(e));
        }
      },
      [code],
    );
    return String(out ?? "(no result)").slice(0, 6000);
  },

  async browser_snapshot({ limit } = {}) {
    const tab = await activeTab();
    await cdp.ensureAttached(tab.id);
    return JSON.stringify(await cdp.axTree(tab.id, limit || 60));
  },

  async browser_console({ limit, level } = {}) {
    const tab = await activeTab();
    const { justAttached } = await cdp.ensureAttached(tab.id);
    const rows = cdp.getConsole(tab.id, { limit: limit || 40, level });
    if (rows.length) return JSON.stringify(rows);
    return justAttached
      ? "Debug mode on — console capture started for this tab. Re-run the action (or browser_reload), then read browser_console again."
      : "(no console messages captured)";
  },

  async browser_network({ limit, filter, body } = {}) {
    const tab = await activeTab();
    const { justAttached } = await cdp.ensureAttached(tab.id);
    if (body) return (await cdp.responseBody(tab.id, body)) || "(empty body)";
    const rows = cdp.getNetwork(tab.id, { limit: limit || 40, filter });
    if (rows.length) return JSON.stringify(rows);
    return justAttached
      ? "Debug mode on — network capture started for this tab. Re-run the action (or browser_reload), then read browser_network again."
      : "(no network requests captured)";
  },
};

export async function dispatchTool(tool, args) {
  if (disabledTools.has(tool)) throw new Error("tool disabled in extension settings: " + tool);
  const spec = TOOL_SPECS.find((s) => s.name === tool);
  if (spec?.requiresDebugger && !cdp.supported()) {
    throw new Error("tool requires debug mode (DevTools Protocol), unavailable in this browser: " + tool);
  }
  const handler = HANDLERS[tool];
  if (!handler) throw new Error("unknown tool: " + tool);
  return await handler(args || {});
}
