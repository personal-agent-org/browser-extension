// Meeting capture orchestration (MV3 service worker side).
//
// The SW can't touch getUserMedia, so audio capture lives in an offscreen document
// (offscreen.html/js). This module is the bridge: it mints a tabCapture stream id for the
// meeting tab, ensures the offscreen doc exists, hands it the stream id + session config
// (serverUrl/token/session/platform/title), and relays the content script's speaker/meta
// events into it. Teardown closes the offscreen doc. Reuses the SW's token/config plumbing
// (passed in from background.js) so the meeting WebSocket authenticates exactly like the
// device socket.
import { api } from "./platform.js";

const OFFSCREEN_PATH = "offscreen.html";

// One active session at a time (one offscreen doc, one meeting WS).
let session = null; // { id, tabId }

function uuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

async function hasOffscreen() {
  if (api.offscreen?.hasDocument) {
    try {
      return await api.offscreen.hasDocument();
    } catch {
      /* fall through to getContexts */
    }
  }
  if (api.runtime?.getContexts) {
    const ctxs = await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await api.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture meeting tab + microphone audio for transcription.",
  });
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await api.offscreen.closeDocument();
  } catch {
    /* already gone */
  }
}

function toOffscreen(msg) {
  // Tagged so the SW's own runtime.onMessage listeners ignore it and only the offscreen doc reads it.
  return api.runtime.sendMessage({ target: "offscreen", ...msg });
}

async function startSession(deps, sender, platform, title) {
  // MV3 offscreen + tabCapture are Chromium-only; fail cleanly elsewhere (e.g. Firefox).
  if (!api.offscreen || !api.tabCapture?.getMediaStreamId) {
    return { ok: false, error: "Meeting capture requires a Chromium-based browser." };
  }
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return { ok: false, error: "No tab to capture." };

  if (session) await stopSession(); // replace any prior session

  const token = await deps.freshAccessToken();
  if (!token) return { ok: false, error: "Not signed in." };
  const cfg = await deps.getConfig();
  if (!cfg.serverUrl) return { ok: false, error: "Server URL not configured." };

  // Mint the tab-audio stream id; the offscreen doc consumes it via getUserMedia(chromeMediaSource:'tab').
  const streamId = await new Promise((resolve, reject) => {
    try {
      api.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        const err = api.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      });
    } catch (e) {
      reject(e);
    }
  });

  await ensureOffscreen();
  const id = uuid();
  session = { id, tabId };
  await toOffscreen({
    type: "start",
    streamId,
    config: {
      serverUrl: cfg.serverUrl.replace(/\/+$/, ""),
      token,
      sessionId: id,
      platform,
      title: title || "Meeting",
    },
  });
  return { ok: true, sessionId: id };
}

async function stopSession() {
  if (!session) return;
  session = null;
  try {
    await toOffscreen({ type: "stop" });
  } catch {
    /* offscreen may already be gone */
  }
  // Give the offscreen doc a beat to flush the WS `stop` frame before we tear it down.
  await new Promise((r) => setTimeout(r, 300));
  await closeOffscreen();
}

// Wire up the SW message + tab-lifecycle handlers. `deps` = { freshAccessToken, getConfig }.
export function registerMeetingHandlers(deps) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.cmd !== "string" || !msg.cmd.startsWith("meeting/")) return; // not ours
    (async () => {
      try {
        if (msg.cmd === "meeting/start") {
          sendResponse(await startSession(deps, sender, msg.platform, msg.title));
        } else if (msg.cmd === "meeting/stop") {
          await stopSession();
          sendResponse({ ok: true });
        } else if (msg.cmd === "meeting/speaker") {
          if (session) {
            await toOffscreen({
              type: "speaker",
              stream: msg.stream,
              speaker: msg.speaker,
              event: msg.event,
            });
          }
          sendResponse({ ok: true });
        } else if (msg.cmd === "meeting/provisioned") {
          // Relayed from the offscreen WS: open the live meeting surface once per session.
          if (session && !session.surfaceOpened && msg.chatId) {
            session.surfaceOpened = true;
            const cfg = await deps.getConfig();
            const base = (cfg.serverUrl || "").replace(/\/+$/, "");
            if (base) api.tabs?.create?.({ url: `${base}/chats/${msg.chatId}` });
          }
          sendResponse({ ok: true });
        } else if (msg.cmd === "meeting/meta") {
          if (session) {
            await toOffscreen({ type: "meta", kind: msg.kind, name: msg.name, text: msg.text });
          }
          sendResponse({ ok: true });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async sendResponse
  });

  // If the captured tab is closed, tear the session down.
  api.tabs?.onRemoved?.addListener((tabId) => {
    if (session && session.tabId === tabId) stopSession();
  });
}
