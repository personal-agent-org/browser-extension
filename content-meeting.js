// Meeting capture content script (isolated world).
//
// Detects a supported meeting platform by SIGNATURE (via PAMeetingRegistry, populated by the
// per-platform adapter files that run before this one), shows a consent banner, and on the
// user's explicit "Aufzeichnen" click starts the active adapter + tells the service worker to
// begin tab+mic audio capture. Speaker/join/leave events from the adapter are relayed to the SW
// (-> offscreen document -> meeting WebSocket). No capture ever starts without the click.

const ext = globalThis.browser ?? globalThis.chrome;
const t = (k) => (ext.i18n && ext.i18n.getMessage(k)) || k;

let activeAdapter = null;
let recording = false;
let bannerHost = null;
let sessionTitle = "";
let dismissed = false;

const emitter = {
  speaker(stream, speaker, event) {
    try {
      ext.runtime.sendMessage({ cmd: "meeting/speaker", stream, speaker, event });
    } catch {
      /* SW asleep or context invalidated */
    }
  },
  meta(kind, name, text) {
    if (kind === "title" && text) sessionTitle = text;
    try {
      ext.runtime.sendMessage({ cmd: "meeting/meta", kind, name: name || "", text: text || "" });
    } catch {
      /* ignore */
    }
  },
};

// ---------- banner (shadow DOM so the host page's CSS can't reach it) ----------
function ensureBanner() {
  if (bannerHost) return bannerHost.shadowRoot;
  bannerHost = document.createElement("div");
  bannerHost.id = "pa-meeting-banner-host";
  // `all:initial` MUST come first: it resets every property, so declaring it last would wipe the
  // position/z-index below and the banner would flow inline (BBB then paints over it). Order wins.
  bannerHost.style.cssText =
    "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;isolation:isolate;";
  const root = bannerHost.attachShadow({ mode: "open" });
  document.documentElement.appendChild(bannerHost);
  return root;
}

function removeBanner() {
  if (bannerHost) {
    bannerHost.remove();
    bannerHost = null;
  }
}

const STYLE = `
  .card{font-family:system-ui,sans-serif;background:#1b2330;color:#e8ecf2;border:1px solid #2f5da6;
    border-radius:10px;padding:12px 14px;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,.4);}
  .title{font-weight:600;font-size:14px;margin:0 0 4px;}
  .note{font-size:12px;color:#aab4c2;margin:0 0 10px;line-height:1.4;}
  .row{display:flex;gap:8px;align-items:center;}
  button{font:inherit;font-size:13px;border-radius:7px;border:0;padding:7px 12px;cursor:pointer;}
  .primary{background:#2f5da6;color:#fff;}
  .ghost{background:transparent;color:#aab4c2;border:1px solid #3a4658;}
  .stop{background:#b23a48;color:#fff;}
  .dot{width:10px;height:10px;border-radius:50%;background:#e5484d;margin-right:8px;
    animation:pa-pulse 1.4s infinite;}
  @keyframes pa-pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .live{display:flex;align-items:center;font-size:13px;font-weight:600;}
  .err{color:#e5a0a0;font-size:12px;margin-top:8px;}
`;

function renderDetected() {
  const root = ensureBanner();
  root.innerHTML = `<style>${STYLE}</style>
    <div class="card">
      <p class="title">${t("meetingDetected")}</p>
      <p class="note">${t("meetingConsent")}</p>
      <div class="row">
        <button class="primary" id="rec">${t("meetingRecordBtn")}</button>
        <button class="ghost" id="close">${t("meetingCloseBtn")}</button>
      </div>
      <p class="err" id="err" hidden></p>
    </div>`;
  root.getElementById("rec").addEventListener("click", startRecording);
  root.getElementById("close").addEventListener("click", () => {
    dismissed = true;
    removeBanner();
  });
}

function renderRecording() {
  const root = ensureBanner();
  root.innerHTML = `<style>${STYLE}</style>
    <div class="card">
      <div class="live"><span class="dot"></span>${t("meetingRecording")}</div>
      <p class="note">${t("meetingConsent")}</p>
      <div class="row">
        <button class="stop" id="stop">${t("meetingStopBtn")}</button>
      </div>
    </div>`;
  root.getElementById("stop").addEventListener("click", stopRecording);
}

function showBannerError(msg) {
  const root = bannerHost && bannerHost.shadowRoot;
  const el = root && root.getElementById("err");
  if (el) {
    el.textContent = msg || t("meetingUnsupported");
    el.hidden = false;
  }
}

// ---------- start / stop ----------
function startRecording() {
  if (!activeAdapter || recording) return;
  const title = sessionTitle || document.title || activeAdapter.name;
  // Platforms that can't attribute the active speaker from the DOM (e.g. OpenTalk) ask the
  // offscreen capture to segment the tab audio itself so a transcript is still produced.
  const attributesSpeakers = activeAdapter.attributesSpeakers !== false;
  ext.runtime.sendMessage(
    { cmd: "meeting/start", platform: activeAdapter.name, title, attributesSpeakers },
    (resp) => {
    if (ext.runtime.lastError) {
      showBannerError(ext.runtime.lastError.message);
      return;
    }
    if (resp && resp.ok) {
      recording = true;
      renderRecording();
      try {
        activeAdapter.start(emitter);
      } catch {
        /* adapter hook failed; audio still captured */
      }
    } else {
      showBannerError((resp && resp.error) || t("meetingUnsupported"));
    }
  });
}

function stopRecording() {
  if (activeAdapter) {
    try {
      activeAdapter.stop();
    } catch {
      /* ignore */
    }
  }
  try {
    ext.runtime.sendMessage({ cmd: "meeting/stop" });
  } catch {
    /* ignore */
  }
  recording = false;
  removeBanner();
}

// ---------- detection (SPA-aware: re-check on mutations until found) ----------
function tryDetect() {
  if (activeAdapter || dismissed) return true;
  const a = globalThis.PAMeetingRegistry && globalThis.PAMeetingRegistry.detect(window);
  if (a) {
    activeAdapter = a;
    renderDetected();
    return true;
  }
  return false;
}

if (!tryDetect()) {
  let ticks = 0;
  const obs = new MutationObserver(() => {
    // Meeting SPAs mount late; poll cheaply on mutation, give up after a while.
    if (tryDetect() || ++ticks > 200) obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

// If the tab navigates/unloads mid-recording, ask the SW to tear the session down cleanly.
window.addEventListener("pagehide", () => {
  if (recording) {
    try {
      ext.runtime.sendMessage({ cmd: "meeting/stop" });
    } catch {
      /* ignore */
    }
  }
});
