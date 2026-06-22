import { api } from "./platform.js";

// Firefox's runtime.sendMessage returns a Promise (no callback arg); Chrome MV3's does too.
function send(cmd, extra = {}) {
  return api.runtime.sendMessage({ cmd, ...extra });
}

const $ = (id) => document.getElementById(id);

// i18n via the native WebExtension catalog (_locales/<lang>/messages.json, api.i18n.getMessage).
// `subs` fills $1/$2 placeholders. A tiny DOM localizer fills the static popup markup from
// data-i18n / data-i18n-placeholder attributes.
const t = (key, subs) => api.i18n.getMessage(key, subs) || "";
function localizeDom() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = t(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const m = t(el.dataset.i18nPlaceholder);
    if (m) el.setAttribute("placeholder", m);
  });
}
// The friendly status label for a raw connection state (falls back to the raw value).
const statusText = (raw) => t("status_" + raw) || raw;

// http is only acceptable for localhost; everything else must be https so the bearer/refresh
// tokens never cross the network in clear. Returns "" when OK, else an error string.
function secureUrlError(v, label) {
  let u;
  try {
    u = new URL(v);
  } catch {
    return t("urlInvalid", [label]);
  }
  const loopback =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "::1" ||
    u.hostname === "[::1]" ||
    u.hostname.endsWith(".localhost");
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return "";
  return t("urlInsecure", [label]);
}

// Only the Server URL is required; the OIDC issuer is auto-discovered from the server
// on Save (the Advanced fields are optional overrides).
function configValid() {
  return secureUrlError($("serverUrl").value.trim(), "Server URL") === "";
}

// Connect stays disabled until a valid server URL is saved AND an issuer is known
// (discovered or entered manually); reflect validity inline.
function reflectConfig() {
  const su = $("serverUrl");
  const is = $("issuer");
  su.classList.toggle("invalid", su.value.trim() !== "" && secureUrlError(su.value.trim(), "x") !== "");
  is.classList.toggle("invalid", is.value.trim() !== "" && secureUrlError(is.value.trim(), "x") !== "");
  $("login").disabled = !(
    configValid() &&
    is.value.trim() !== "" &&
    secureUrlError(is.value.trim(), "x") === ""
  );
}

async function refresh() {
  const s = await send("status");
  const dot = $("dot");
  const raw = s.status || "idle";
  dot.className = "dot " + raw;
  $("status").textContent = statusText(raw);
  $("device").textContent = s.device_id
    ? t("deviceLabel", [s.device_id.slice(0, 8) + "…"])
    : t("notRegistered");
  // Only overwrite a field the user isn't actively editing, so typing isn't clobbered.
  if (document.activeElement !== $("serverUrl")) $("serverUrl").value = s.serverUrl || "";
  if (document.activeElement !== $("issuer")) $("issuer").value = s.issuer || "";
  if (document.activeElement !== $("clientId")) $("clientId").value = s.clientId || "";
  reflectConfig();
}

["serverUrl", "issuer"].forEach((id) => $(id).addEventListener("input", reflectConfig));

$("save").addEventListener("click", async () => {
  $("cfgErr").textContent = "";
  const serverUrl = $("serverUrl").value.trim();
  const suErr = secureUrlError(serverUrl, t("serverUrlLabel"));
  if (suErr) {
    $("cfgErr").textContent = suErr;
    return;
  }
  let issuer = $("issuer").value.trim();
  let clientId = $("clientId").value.trim();
  if (issuer) {
    const isErr = secureUrlError(issuer, t("issuerLabel"));
    if (isErr) {
      $("cfgErr").textContent = isErr;
      return;
    }
  }
  // No manual issuer override → ask the server for it (only the URL is required).
  if (!issuer) {
    $("status").textContent = t("discovering");
    const d = await send("discover", { serverUrl });
    if (!d?.ok) {
      $("cfgErr").textContent = t("discoverFailed", [d?.error || "unknown"]);
      $("status").textContent = t("status_not_configured");
      return;
    }
    issuer = d.issuer;
    clientId = clientId || d.clientId;
    $("issuer").value = issuer;
    $("clientId").value = clientId;
  }
  await send("saveConfig", {
    config: { serverUrl, issuer, clientId: clientId || "personal-agent-browser" },
  });
  $("status").textContent = t("saved");
  reflectConfig();
  setTimeout(refresh, 300);
});

$("login").addEventListener("click", async () => {
  if (!configValid()) {
    $("cfgErr").textContent = t("saveValidFirst");
    return;
  }
  // First connect ever: have the user review which tools the assistant may use before we sign
  // in + announce them. Surface the selector; the next Connect (or a Save) proceeds.
  if (!toolsReviewed) {
    toolsReviewed = true; // a second Connect click proceeds
    await send("ackTools"); // persist so this prompt won't reappear
    $("toolsMsg").textContent = t("firstReviewPrompt");
    const fs = $("toolList").closest("fieldset") || $("toolList");
    fs.classList.add("flash");
    setTimeout(() => fs.classList.remove("flash"), 1600);
    fs.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  $("status").textContent = t("signingIn");
  const r = await send("login");
  if (!r?.ok) $("status").textContent = t("loginFailed", [r?.error || ""]);
  setTimeout(refresh, 500);
});

$("logout").addEventListener("click", async () => {
  $("status").textContent = t("disconnecting");
  await send("logout");
  refresh();
});

// ---------- exposed-tools settings ----------
// Has the user consciously reviewed the exposed-tools set at least once? The first Connect is
// gated on this so they choose what the assistant may do (mirrors the Android onboarding step).
let toolsReviewed = true;

async function renderTools() {
  const res = await send("tools");
  toolsReviewed = !!res?.reviewed;
  const list = $("toolList");
  list.textContent = "";
  const disabled = new Set(res?.disabled || []);
  (res?.specs || []).forEach((spec) => {
    const row = document.createElement("label");
    row.className = "toolrow";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !disabled.has(spec.name);
    cb.dataset.tool = spec.name;
    cb.title = spec.description || "";
    const name = document.createElement("span");
    name.className = "toolname";
    name.textContent = spec.name.replace(/^browser_/, "");
    row.appendChild(cb);
    row.appendChild(name);
    if (spec.write) {
      const tag = document.createElement("span");
      tag.className = "tag write";
      tag.textContent = t("writeTag");
      row.appendChild(tag);
    }
    list.appendChild(row);
  });
  $("blockedHosts").value = (res?.blockedHosts || []).join("\n");
}

function setAllTools(v) {
  document.querySelectorAll("#toolList input[type=checkbox]").forEach((cb) => (cb.checked = v));
}
$("toolsAll").addEventListener("click", () => setAllTools(true));
$("toolsNone").addEventListener("click", () => setAllTools(false));

$("saveTools").addEventListener("click", async () => {
  const disabled = Array.from(document.querySelectorAll("#toolList input[type=checkbox]"))
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool);
  const blockedHosts = $("blockedHosts")
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  await send("saveTools", { disabled, blockedHosts });
  toolsReviewed = true; // saving counts as a conscious review → first-login gate cleared
  $("toolsMsg").textContent = t("savedReconnect");
  setTimeout(() => ($("toolsMsg").textContent = ""), 2500);
});

localizeDom();
renderTools();
refresh();
setInterval(refresh, 2000);
