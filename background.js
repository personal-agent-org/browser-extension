// Personal Agent browser device — MV3 service worker.
// Authenticates the user (Keycloak OIDC + PKCE), registers a kind=browser device, then holds a
// WebSocket to the backend's device gateway: announces browser_* tools and serves rpc_call
// frames by driving the active tab (see tools.js). Protocol mirrors the Rust device-agent.

import {
  TOOL_SPECS,
  dispatchTool,
  setDisabledTools,
  announcedSpecs,
  setBlockedOrigins,
} from "./tools.js";
import { api, engineName } from "./platform.js";
import { secureUrlKind } from "./urls.js";

// No instance is baked in: a self-hoster configures these in the popup (persisted to
// api.storage.local via getConfig()/saveConfig). serverUrl + issuer are REQUIRED
// before connect; clientId defaults to the realm's public browser client.
const DEFAULTS = {
  serverUrl: "",
  issuer: "",
  clientId: "personal-agent-browser",
};
const AGENT_VERSION = api.runtime.getManifest().version;

let ws = null;
let connecting = false;
let reconnectTimer = null;
let backoff = 1000;

// ---------- config + token storage ----------
async function getConfig() {
  const c = await api.storage.local.get(["serverUrl", "issuer", "clientId"]);
  return { ...DEFAULTS, ...c };
}
async function getTokens() {
  return await api.storage.local.get(["access_token", "refresh_token", "expires_at", "device_id"]);
}
async function setTokens(patch) {
  await api.storage.local.set(patch);
}

// Bootstrap discovery: given only the Server URL, ask the deployment for its OIDC
// issuer + public browser client id (GET /api/v1/public/client-config) so the user
// doesn't have to enter them by hand. Returns {issuer, clientId} on success.
async function discoverConfig(serverUrl) {
  requireSecure(serverUrl, "Server URL"); // never bootstrap discovery over cleartext
  const base = serverUrl.replace(/\/+$/, "");
  const r = await fetch(`${base}/api/v1/public/client-config`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`discovery failed (HTTP ${r.status})`);
  const c = await r.json();
  if (!c.oidc_issuer) throw new Error("server returned no oidc_issuer");
  return { issuer: c.oidc_issuer, clientId: c.browser_client_id || DEFAULTS.clientId };
}

async function oidcConfig() {
  const { issuer } = await getConfig();
  const r = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error("OIDC discovery failed");
  return await r.json();
}

// ---------- transport safety ----------
// Refuse cleartext for anything but localhost: the bearer token rides the WS subprotocol and the
// OIDC exchange carries the (long-lived) refresh token — neither may cross the network in clear.
function requireSecure(urlStr, label) {
  const kind = secureUrlKind(urlStr);
  if (kind === "invalid") throw new Error(`${label} is not a valid URL`);
  if (kind === "insecure") {
    throw new Error(`${label} must use https (http is only allowed for localhost)`);
  }
}

// Push the user's exposure settings into the tools module before each connect / after a change:
// the announce filter + dispatch guard (which tools exist) and the origin guard (which sites the
// agent may drive). The app's own origin and the IdP are ALWAYS blocked (token/consent theft).
async function applyToolPolicy() {
  const cfg = await getConfig();
  const { disabledTools, blockedHosts } = await api.storage.local.get([
    "disabledTools",
    "blockedHosts",
  ]);
  setDisabledTools(disabledTools || []);
  const blocked = [];
  if (cfg.serverUrl) blocked.push(cfg.serverUrl);
  if (cfg.issuer) blocked.push(cfg.issuer);
  if (Array.isArray(blockedHosts)) blocked.push(...blockedHosts);
  setBlockedOrigins(blocked);
}

// ---------- PKCE ----------
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

// Interactive login via the OAuth2 auth-code + PKCE flow (chrome.identity).
async function login() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.issuer) {
    throw new Error("Configure Server URL and OIDC issuer in Settings first");
  }
  requireSecure(cfg.serverUrl, "Server URL");
  requireSecure(cfg.issuer, "OIDC issuer");
  const oidc = await oidcConfig();
  const redirect = api.identity.getRedirectURL();
  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl =
    `${oidc.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(cfg.clientId)}` +
    // offline_access → the refresh token survives ssoSessionIdleTimeout (30 min), so a
    // background device reconnects after long idle without an interactive re-login.
    `&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent("openid profile email offline_access")}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
  const redirected = await api.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const u = new URL(redirected);
  if (u.searchParams.get("state") !== state) throw new Error("state mismatch");
  const code = u.searchParams.get("code");
  if (!code) throw new Error("no auth code");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(oidc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token exchange failed: " + r.status);
  const t = await r.json();
  await storeToken(t);
  await connect();
  return true;
}

async function storeToken(t) {
  await setTokens({
    access_token: t.access_token,
    refresh_token: t.refresh_token || (await getTokens()).refresh_token,
    expires_at: Date.now() + (t.expires_in || 60) * 1000 - 15000,
  });
}

async function freshAccessToken() {
  const { access_token, refresh_token, expires_at } = await getTokens();
  if (access_token && expires_at && Date.now() < expires_at) return access_token;
  if (!refresh_token) {
    setStatus("signin_required");
    return null;
  }
  const cfg = await getConfig();
  let oidc;
  try {
    oidc = await oidcConfig();
  } catch {
    setStatus("error: discovery failed");
    return null;
  }
  let r;
  try {
    r = await fetch(oidc.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: cfg.clientId,
      }),
    });
  } catch {
    setStatus("error: refresh failed");
    return null; // transient — keepalive will retry; tokens kept
  }
  if (!r.ok) {
    // invalid_grant = refresh token expired/revoked/rotated → require interactive re-login.
    let err = "";
    try {
      err = (await r.json()).error || "";
    } catch {
      /* non-JSON body */
    }
    if (err === "invalid_grant") {
      await api.storage.local.remove(["access_token", "refresh_token", "expires_at"]);
      setStatus("signin_required");
    } else {
      setStatus("error: refresh failed");
    }
    return null;
  }
  const t = await r.json();
  await storeToken(t);
  return t.access_token;
}

// ---------- device registration ----------
async function ensureDevice(token) {
  const existing = (await getTokens()).device_id;
  if (existing) return existing;
  const cfg = await getConfig();
  const name = engineName() + " — " + (self.navigator?.userAgent?.includes("Mac") ? "macOS" : "Browser");
  const r = await fetch(`${cfg.serverUrl}/api/v1/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error("device registration failed: " + r.status);
  const d = await r.json();
  await setTokens({ device_id: d.id });
  return d.id;
}

// ---------- teardown ----------
// Best-effort OAuth2 token revocation (RFC 7009) at the IdP's revocation endpoint.
async function revokeToken(token, hint) {
  if (!token) return;
  let oidc;
  try {
    oidc = await oidcConfig();
  } catch {
    return;
  }
  if (!oidc.revocation_endpoint) return;
  const cfg = await getConfig();
  try {
    await fetch(oidc.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: cfg.clientId }),
    });
  } catch {
    /* best-effort */
  }
}

// Disconnect = secure teardown: delete the device server-side, then revoke the refresh + access
// tokens at the IdP (so the long-lived offline token can't be reused), then drop local state.
async function logout() {
  const before = await getTokens();
  let bearer = before.access_token;
  if (before.device_id) {
    try {
      bearer = (await freshAccessToken()) || before.access_token;
    } catch {
      /* fall back to the stored token */
    }
    if (bearer) {
      const cfg = await getConfig();
      try {
        await fetch(`${cfg.serverUrl}/api/v1/devices/${before.device_id}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + bearer },
        });
      } catch {
        /* best-effort */
      }
    }
  }
  // freshAccessToken() may have rotated the refresh token — re-read before revoking.
  const now = await getTokens();
  await revokeToken(now.refresh_token, "refresh_token");
  await revokeToken(bearer || now.access_token, "access_token");
  await api.storage.local.remove(["access_token", "refresh_token", "expires_at", "device_id"]);
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  setStatus("signin_required");
}

// ---------- WebSocket device loop ----------
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

async function connect() {
  // Reject any non-CLOSED socket so a keepalive tick / scheduled retry can't stack duplicates.
  if (connecting || (ws && ws.readyState !== WebSocket.CLOSED)) return;
  // Nothing baked in: without a Server URL + OIDC issuer there is nowhere to connect.
  // Stay idle (don't fetch an empty issuer) until the popup saves a configuration.
  const cfg0 = await getConfig();
  if (!cfg0.serverUrl || !cfg0.issuer) {
    setStatus("not_configured");
    return;
  }
  try {
    requireSecure(cfg0.serverUrl, "Server URL");
    requireSecure(cfg0.issuer, "OIDC issuer");
  } catch (e) {
    setStatus("error: " + (e?.message || e));
    return;
  }
  connecting = true;
  try {
    const token = await freshAccessToken();
    if (!token) return; // status already set (signin_required / error); keepalive retries
    const cfg = await getConfig();
    const deviceId = await ensureDevice(token);
    await applyToolPolicy(); // load exposure + origin policy before we announce / serve calls
    const wsUrl = cfg.serverUrl.replace(/^http/, "ws") + "/api/v1/ws/device";
    // ':' is NOT a valid WS subprotocol token char (the constructor would throw) → use
    // 'bearer.' as the delimiter; the backend accepts both 'bearer.' and 'bearer:'.
    const sock = new WebSocket(wsUrl, ["device", deviceId, "bearer." + token]);
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sock.send(
        JSON.stringify({
          type: "hello",
          v: 1,
          capabilities: ["browser"],
          tools: announcedSpecs(), // only the tools the user left enabled in Settings
          agent_version: AGENT_VERSION,
        }),
      );
      setStatus("connected");
    };
    sock.onmessage = (ev) => handleFrame(sock, ev.data);
    sock.onclose = () => {
      if (ws === sock) ws = null;
      setStatus("disconnected");
      scheduleReconnect();
    };
    sock.onerror = () => {
      setStatus("error");
      try {
        sock.close(); // force onclose → one scheduleReconnect
      } catch {
        /* ignore */
      }
    };
  } catch (e) {
    setStatus("error: " + (e?.message || e));
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

async function handleFrame(sock, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (frame.type === "ping") {
    sock.send(JSON.stringify({ type: "pong", v: 1 }));
    return;
  }
  if (frame.type === "rpc_call") {
    const reply = { type: "rpc_result", v: 1, req_id: frame.req_id, ok: true, result: "", error: "" };
    try {
      reply.result = String(await dispatchTool(frame.tool, frame.args));
    } catch (e) {
      reply.ok = false;
      reply.error = e?.message || String(e);
    }
    try {
      sock.send(JSON.stringify(reply));
    } catch {
      /* socket closed mid-call; the run times out server-side */
    }
  }
}

function setStatus(s) {
  api.storage.local.set({ status: s });
}

// Keepalive: a closed socket gets reconnected; an active socket's ping/pong keeps the SW alive.
api.alarms.create("keepalive", { periodInMinutes: 1 });
api.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") connect();
});
api.runtime.onStartup.addListener(() => connect());
api.runtime.onInstalled.addListener(() => connect());

// Popup messaging.
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.cmd === "login") {
      try {
        await login();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    } else if (msg.cmd === "status") {
      const s = await api.storage.local.get(["status", "device_id"]);
      const cfg = await getConfig();
      sendResponse({ status: s.status || "idle", device_id: s.device_id || null, ...cfg });
    } else if (msg.cmd === "discover") {
      try {
        const d = await discoverConfig(msg.serverUrl || "");
        sendResponse({ ok: true, ...d });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    } else if (msg.cmd === "saveConfig") {
      // Whitelist: a config message must never write token/device keys into storage.
      const c = msg.config || {};
      const clean = {};
      if (typeof c.serverUrl === "string") clean.serverUrl = c.serverUrl;
      if (typeof c.issuer === "string") clean.issuer = c.issuer;
      if (typeof c.clientId === "string") clean.clientId = c.clientId;
      await api.storage.local.set(clean);
      sendResponse({ ok: true });
    } else if (msg.cmd === "tools") {
      const { disabledTools, blockedHosts, toolsReviewed } = await api.storage.local.get([
        "disabledTools",
        "blockedHosts",
        "toolsReviewed",
      ]);
      sendResponse({
        specs: TOOL_SPECS.map((s) => ({
          name: s.name,
          write: !!s.write,
          description: s.description,
        })),
        disabled: disabledTools || [],
        blockedHosts: blockedHosts || [],
        // Has the user consciously reviewed the exposed-tools set at least once? (Drives the
        // first-login prompt so they pick what the assistant may do before connecting.)
        reviewed: !!toolsReviewed,
      });
    } else if (msg.cmd === "ackTools") {
      // The user acknowledged the exposed-tools set at first login (without changing it).
      await api.storage.local.set({ toolsReviewed: true });
      sendResponse({ ok: true });
    } else if (msg.cmd === "saveTools") {
      const disabled = Array.isArray(msg.disabled)
        ? msg.disabled.filter((x) => typeof x === "string")
        : [];
      const blockedHosts = Array.isArray(msg.blockedHosts)
        ? msg.blockedHosts.filter((x) => typeof x === "string")
        : [];
      await api.storage.local.set({ disabledTools: disabled, blockedHosts, toolsReviewed: true });
      await applyToolPolicy();
      // The tool set is announced only in the hello frame, so cycle the socket to re-announce.
      backoff = 1000;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.close(); // onclose → scheduleReconnect → fresh hello with the new tool set
        } catch {
          /* ignore */
        }
      } else {
        connect();
      }
      sendResponse({ ok: true });
    } else if (msg.cmd === "logout") {
      await logout();
      sendResponse({ ok: true });
    }
  })();
  return true; // async response
});

connect();
