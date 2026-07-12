// Personal Agent browser device — MV3 service worker.
// Authenticates the user (mode-agnostic: Keycloak OIDC + PKCE, or the backend's own local IdP via
// the RFC 8628 device grant: see auth.js), registers a kind=browser device, then holds a
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
import { registerMeetingHandlers } from "./meeting.js";
import {
  AuthError,
  DEFAULT_CLIENT_ID,
  createSingleFlightRefresh,
  parseClientConfig,
  pollDeviceToken,
  resolveDeviceEndpoints,
  startDeviceAuthorization,
  tokenPatch,
} from "./auth.js";

// No instance is baked in: a self-hoster configures these in the popup (persisted to
// api.storage.local via getConfig()/saveConfig). serverUrl is REQUIRED before connect;
// the rest (auth mode, issuer, client id, device-grant endpoints) is discovered from the
// server's /api/v1/public/client-config. `issuer` only exists in oidc mode.
const DEFAULTS = {
  serverUrl: "",
  authMode: "oidc",
  issuer: "",
  clientId: DEFAULT_CLIENT_ID,
  deviceAuthEndpoint: "",
  deviceTokenEndpoint: "",
};
const AGENT_VERSION = api.runtime.getManifest().version;

let ws = null;
let connecting = false;
let reconnectTimer = null;
let backoff = 1000;

// ---------- config + token storage ----------
async function getConfig() {
  const c = await api.storage.local.get([
    "serverUrl",
    "authMode",
    "issuer",
    "clientId",
    "deviceAuthEndpoint",
    "deviceTokenEndpoint",
  ]);
  return { ...DEFAULTS, ...c };
}
async function getTokens() {
  return await api.storage.local.get(["access_token", "refresh_token", "expires_at", "device_id"]);
}
async function setTokens(patch) {
  await api.storage.local.set(patch);
}

// Bootstrap discovery: given only the Server URL, ask the deployment how it authenticates
// (GET /api/v1/public/client-config) so the user doesn't have to enter anything by hand:
// auth mode, OIDC issuer + public browser client id, and the device-grant endpoints.
async function discoverConfig(serverUrl) {
  requireSecure(serverUrl, "Server URL"); // never bootstrap discovery over cleartext
  const base = serverUrl.replace(/\/+$/, "");
  const r = await fetch(`${base}/api/v1/public/client-config`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`discovery failed (HTTP ${r.status})`);
  return parseClientConfig(await r.json());
}

async function oidcConfig() {
  const { issuer } = await getConfig();
  const r = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error("OIDC discovery failed");
  return await r.json();
}

// The token endpoint for the configured mode. Both modes refresh with grant_type=refresh_token;
// in local mode the device-grant token endpoint serves the refresh grant too.
async function tokenEndpoint(cfg) {
  if (cfg.authMode === "local") return resolveDeviceEndpoints(cfg).deviceToken;
  return (await oidcConfig()).token_endpoint;
}

// Is the deployment configured enough to sign in / connect? In oidc mode the issuer is required
// (that IS the IdP); in local mode there is no Keycloak, so a server URL is all we need.
function isConfigured(cfg) {
  return !!cfg.serverUrl && (cfg.authMode === "local" || !!cfg.issuer);
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

// The ONE public login entry point. Callers (popup, keepalive) never care which IdP the
// deployment runs: the mode picked at discovery decides which flow runs, both end with a token
// pair in storage + a connected device socket.
async function login() {
  const cfg = await getConfig();
  if (!isConfigured(cfg)) throw new Error("Configure the Server URL in Settings first");
  requireSecure(cfg.serverUrl, "Server URL");
  if (cfg.issuer) requireSecure(cfg.issuer, "OIDC issuer");
  const t = cfg.authMode === "local" ? await deviceGrantLogin(cfg) : await pkceLogin(cfg);
  await storeToken(t);
  await connect();
  return true;
}

// local mode: OAuth 2.0 Device Authorization Grant (RFC 8628). No authorization endpoint and no
// redirect exist here, so we get a user_code, send the user to the SPA's /activate page (the code
// is prefilled in verification_uri_complete; the popup also shows it for manual entry) and poll.
async function deviceGrantLogin(cfg) {
  const { deviceAuthorization, deviceToken } = resolveDeviceEndpoints(cfg);
  requireSecure(deviceAuthorization, "Device authorization endpoint");
  requireSecure(deviceToken, "Device token endpoint");
  const d = await startDeviceAuthorization({
    fetchImpl: fetch,
    endpoint: deviceAuthorization,
    clientId: cfg.clientId,
  });
  await api.storage.local.set({ user_code: d.userCode, verification_uri: d.verificationUri });
  setStatus("awaiting_approval");
  if (d.verificationUriComplete) {
    try {
      await api.tabs.create({ url: d.verificationUriComplete });
    } catch {
      /* no tab (e.g. no window open): the popup still shows the code + URL */
    }
  }
  try {
    return await pollDeviceToken({
      fetchImpl: fetch,
      endpoint: deviceToken,
      clientId: cfg.clientId,
      deviceCode: d.deviceCode,
      interval: d.interval, // honour the server's interval; pollDeviceToken backs off on slow_down
      expiresIn: d.expiresIn,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
  } finally {
    await api.storage.local.remove(["user_code", "verification_uri"]);
  }
}

// oidc mode: interactive login via the OAuth2 auth-code + PKCE flow (chrome.identity).
async function pkceLogin(cfg) {
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
  return await r.json();
}

async function storeToken(t) {
  await setTokens(tokenPatch(t, (await getTokens()).refresh_token));
}

// One shared refresher for BOTH modes (only the endpoint differs). Refresh tokens are single-use
// and rotated, and replaying a rotated one is treated as theft (it revokes every session of the
// user), so concurrent callers must never each send the stored token: createSingleFlightRefresh
// collapses them onto one request and persists the rotated pair before handing the token out.
const refreshTokens = createSingleFlightRefresh({
  fetchImpl: (...a) => fetch(...a),
  getSession: async () => {
    const cfg = await getConfig();
    const { refresh_token } = await getTokens();
    return { endpoint: await tokenEndpoint(cfg), clientId: cfg.clientId, refreshToken: refresh_token };
  },
  saveTokens: setTokens,
});

async function freshAccessToken() {
  const { access_token, expires_at } = await getTokens();
  if (access_token && expires_at && Date.now() < expires_at) return access_token;
  try {
    return await refreshTokens();
  } catch (e) {
    const code = e instanceof AuthError ? e.code : "error";
    if (code === "signin_required" || code === "invalid_grant") {
      // No / expired / revoked / already-rotated refresh token → interactive re-login.
      await api.storage.local.remove(["access_token", "refresh_token", "expires_at"]);
      setStatus("signin_required");
    } else {
      setStatus("error: refresh failed"); // transient: keepalive retries; tokens kept
    }
    return null;
  }
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
// Best-effort OAuth2 token revocation (RFC 7009) at the IdP's revocation endpoint. oidc mode only:
// in local mode there is no Keycloak session to end, so logout just drops the stored tokens.
async function revokeToken(token, hint) {
  if (!token) return;
  const { authMode } = await getConfig();
  if (authMode === "local") return;
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
  await api.storage.local.remove([
    "access_token",
    "refresh_token",
    "expires_at",
    "device_id",
    "user_code",
    "verification_uri",
  ]);
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
  // Nothing baked in: without a Server URL (plus, in oidc mode, an issuer) there is nowhere to
  // connect. Stay idle (don't fetch an empty issuer) until the popup saves a configuration.
  const cfg0 = await getConfig();
  if (!isConfigured(cfg0)) {
    setStatus("not_configured");
    return;
  }
  try {
    requireSecure(cfg0.serverUrl, "Server URL");
    if (cfg0.issuer) requireSecure(cfg0.issuer, "OIDC issuer");
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
      const s = await api.storage.local.get([
        "status",
        "device_id",
        "user_code",
        "verification_uri",
      ]);
      const cfg = await getConfig();
      sendResponse({
        status: s.status || "idle",
        device_id: s.device_id || null,
        // Device grant in flight: the popup shows the code so the user can also type it manually.
        user_code: s.user_code || null,
        verification_uri: s.verification_uri || null,
        ...cfg,
      });
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
      for (const k of [
        "serverUrl",
        "issuer",
        "clientId",
        "deviceAuthEndpoint",
        "deviceTokenEndpoint",
      ]) {
        if (typeof c[k] === "string") clean[k] = c[k];
      }
      if (c.authMode === "local" || c.authMode === "oidc") clean.authMode = c.authMode;
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

// Meeting capture (tab+mic audio -> offscreen doc -> /api/v1/ws/meeting). Reuses this SW's
// token + config plumbing; Chromium-only (guarded inside on non-offscreen browsers).
registerMeetingHandlers({ freshAccessToken, getConfig });

connect();
