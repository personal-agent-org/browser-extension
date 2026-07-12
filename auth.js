// Mode-agnostic authentication core, shared by the service worker (background.js) and the unit
// tests. A Personal Agent deployment runs EITHER with Keycloak in front of it (auth_mode "oidc")
// or with the backend's own local identity provider (auth_mode "local", no Keycloak at all).
//
//   oidc  -> OAuth2 auth-code + PKCE in a browser redirect (chrome.identity.launchWebAuthFlow).
//   local -> OAuth 2.0 Device Authorization Grant (RFC 8628): there is no authorization endpoint
//            and no redirect flow, so the extension asks for a user_code, sends the user to the
//            SPA's /activate page and polls the token endpoint until it is approved.
//
// Both modes end in the same place: an access + refresh token pair in storage, refreshed with
// grant_type=refresh_token against a token endpoint. Only the endpoint differs, so refresh is ONE
// code path for both modes (see createSingleFlightRefresh).
//
// Deliberately dependency-free (no WebExtension `api`, no DOM, injected fetch/sleep) so it loads
// in every context AND can be unit-tested under plain Node (see test/auth.test.js).

export const DEFAULT_CLIENT_ID = "personal-agent-browser";
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Terminal device-grant / refresh failures carry a machine-readable code so the caller can map it
// to a status (e.g. invalid_grant -> re-login) without string-matching messages.
export class AuthError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

// ---------- client-config ----------

// Keycloak's well-known device-grant URLs, derived from the issuer.
export function keycloakDeviceEndpoints(issuer) {
  const base = String(issuer || "").replace(/\/+$/, "");
  if (!base) return { deviceAuthorization: "", deviceToken: "" };
  return {
    deviceAuthorization: `${base}/protocol/openid-connect/auth/device`,
    deviceToken: `${base}/protocol/openid-connect/token`,
  };
}

function absolutize(url, base) {
  if (!url) return "";
  try {
    return new URL(url, base || undefined).toString();
  } catch {
    return "";
  }
}

// GET /api/v1/public/client-config -> the settings we persist. `auth_mode` and the two device
// endpoints are recent additions: an OLDER backend omits them, and an old backend is by
// definition a Keycloak one, so default the mode to "oidc" and let resolveDeviceEndpoints()
// derive the URLs from the issuer. That keeps a new extension working against an old server.
export function parseClientConfig(raw, { defaultClientId = DEFAULT_CLIENT_ID } = {}) {
  const c = raw || {};
  const authMode = c.auth_mode === "local" ? "local" : "oidc";
  if (authMode === "oidc" && !c.oidc_issuer) throw new AuthError("server returned no oidc_issuer");
  return {
    authMode,
    issuer: c.oidc_issuer || "",
    clientId: c.browser_client_id || defaultClientId,
    deviceAuthEndpoint: c.device_authorization_endpoint || "",
    deviceTokenEndpoint: c.device_token_endpoint || "",
  };
}

// The device-grant endpoints for a stored config: the advertised ones win, otherwise fall back to
// the Keycloak-derived URLs (old backend, see parseClientConfig). Relative URLs are resolved
// against the server URL so a backend may advertise a path.
export function resolveDeviceEndpoints(cfg = {}) {
  const fb = keycloakDeviceEndpoints(cfg.issuer);
  const deviceAuthorization =
    absolutize(cfg.deviceAuthEndpoint, cfg.serverUrl) || fb.deviceAuthorization;
  const deviceToken = absolutize(cfg.deviceTokenEndpoint, cfg.serverUrl) || fb.deviceToken;
  if (!deviceAuthorization || !deviceToken) {
    throw new AuthError("server advertises no device-grant endpoints", "not_configured");
  }
  return { deviceAuthorization, deviceToken };
}

// ---------- token shape ----------

// Normalize a token response into what we persist. `expires_at` is 15 s early so a token is never
// used in the last moments of its life. A response without a new refresh token keeps the old one.
export function tokenPatch(t, previousRefresh = null) {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || previousRefresh || null,
    expires_at: Date.now() + (t.expires_in || 60) * 1000 - 15000,
  };
}

// ---------- device authorization grant (RFC 8628) ----------

async function postForm(fetchImpl, url, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v) body.set(k, v);
  return await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
}

async function readJson(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

// Step 1: ask for a device_code + user_code. `client_id` is optional server-side; we send ours.
export async function startDeviceAuthorization({ fetchImpl, endpoint, clientId }) {
  const r = await postForm(fetchImpl, endpoint, {
    client_id: clientId,
    scope: "openid profile email offline_access",
  });
  if (!r.ok) throw new AuthError(`device authorization failed (HTTP ${r.status})`, "http");
  const d = await readJson(r);
  if (!d.device_code || !d.user_code) throw new AuthError("device authorization: bad response");
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri || "",
    verificationUriComplete: d.verification_uri_complete || d.verification_uri || "",
    interval: Number(d.interval) > 0 ? Number(d.interval) : 5,
    expiresIn: Number(d.expires_in) > 0 ? Number(d.expires_in) : 600,
  };
}

// The polling state machine, as a pure decision over ONE token-endpoint response.
//   pending    -> keep polling at the current interval
//   slow_down  -> keep polling, but the server wants a longer interval (it grows its own and
//                 would keep rejecting us otherwise), so back off by RFC 8628's +5 s
//   token      -> done
//   fail       -> terminal (expired_token / access_denied / anything unexpected)
export function devicePollOutcome(status, body) {
  const b = body || {};
  if (status >= 200 && status < 300 && b.access_token) return { action: "token", token: b };
  const error = b.error || "";
  if (error === "authorization_pending") return { action: "pending" };
  if (error === "slow_down") return { action: "slow_down" };
  if (error === "expired_token") {
    return { action: "fail", code: "expired_token", message: "the sign-in code expired" };
  }
  if (error === "access_denied") {
    return { action: "fail", code: "access_denied", message: "sign-in was denied" };
  }
  return {
    action: "fail",
    code: error || "http",
    message: error || `device token request failed (HTTP ${status})`,
  };
}

export const SLOW_DOWN_STEP = 5; // seconds, per RFC 8628 section 3.5

// Step 2: poll until approved / denied / expired. `sleep` and `now` are injected so the state
// machine is testable without real time.
export async function pollDeviceToken({
  fetchImpl,
  endpoint,
  clientId,
  deviceCode,
  interval = 5,
  expiresIn = 600,
  sleep,
  now = () => Date.now(),
  onPoll = null,
}) {
  let delay = interval;
  const deadline = now() + expiresIn * 1000;
  for (;;) {
    await sleep(delay * 1000);
    // Checked after waking, not before: the code can only expire while we wait.
    if (now() >= deadline) throw new AuthError("the sign-in code expired", "expired_token");
    const r = await postForm(fetchImpl, endpoint, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: clientId,
    });
    const outcome = devicePollOutcome(r.status, await readJson(r));
    onPoll?.(outcome);
    if (outcome.action === "token") return outcome.token;
    if (outcome.action === "fail") throw new AuthError(outcome.message, outcome.code);
    if (outcome.action === "slow_down") delay += SLOW_DOWN_STEP;
  }
}

// ---------- refresh (identical in both modes) ----------

export async function refreshGrant({ fetchImpl, endpoint, clientId, refreshToken }) {
  let r;
  try {
    r = await postForm(fetchImpl, endpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
  } catch (e) {
    throw new AuthError(`refresh failed: ${e?.message || e}`, "network");
  }
  if (!r.ok) {
    const err = (await readJson(r)).error || "";
    // invalid_grant = expired / revoked / already-rotated refresh token -> interactive re-login.
    throw new AuthError(`refresh failed (HTTP ${r.status})`, err || "http");
  }
  return await readJson(r);
}

// Single-flight refresh. Refresh tokens are SINGLE-USE and rotated: the backend treats a replay of
// an already-rotated token as theft and revokes every session of that user. Two callers racing
// (e.g. the WS reconnect and the meeting capture) would otherwise send the same token twice, so
// concurrent callers share ONE in-flight request, and the new pair is persisted BEFORE the access
// token is handed out - a caller can never observe a token whose rotation was not yet stored.
export function createSingleFlightRefresh({ fetchImpl, getSession, saveTokens }) {
  let inFlight = null;

  async function run() {
    const { endpoint, clientId, refreshToken } = await getSession();
    if (!refreshToken) throw new AuthError("no refresh token", "signin_required");
    const t = await refreshGrant({ fetchImpl, endpoint, clientId, refreshToken });
    if (!t.access_token) throw new AuthError("refresh returned no access token", "http");
    await saveTokens(tokenPatch(t, refreshToken));
    return t.access_token;
  }

  return function refresh() {
    if (!inFlight) {
      inFlight = run().finally(() => {
        inFlight = null; // cleared only after the rotation is persisted -> the next call is safe
      });
    }
    return inFlight;
  };
}
