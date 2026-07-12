import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  DEVICE_CODE_GRANT,
  createSingleFlightRefresh,
  devicePollOutcome,
  parseClientConfig,
  pollDeviceToken,
  resolveDeviceEndpoints,
  startDeviceAuthorization,
} from "../auth.js";

// A fetch stub: `responses` is a queue of {status, body}; every call is recorded.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    const r = responses.shift();
    if (!r) throw new Error("unexpected fetch: " + url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

// A sleep stub that records the requested delays instead of waiting.
function fakeSleep() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

// ---------- client-config + endpoint resolution ----------

test("parseClientConfig defaults an old backend (no auth_mode) to oidc", () => {
  const c = parseClientConfig({ oidc_issuer: "https://kc.test/realms/pa", browser_client_id: "b" });
  assert.equal(c.authMode, "oidc");
  assert.equal(c.issuer, "https://kc.test/realms/pa");
  assert.equal(c.clientId, "b");
  assert.equal(c.deviceAuthEndpoint, "");
  assert.equal(c.deviceTokenEndpoint, "");
});

test("parseClientConfig reads local mode + the advertised device endpoints", () => {
  const c = parseClientConfig({
    auth_mode: "local",
    device_authorization_endpoint: "https://pa.test/api/v1/auth/device/code",
    device_token_endpoint: "https://pa.test/api/v1/auth/device/token",
  });
  assert.equal(c.authMode, "local");
  assert.equal(c.issuer, ""); // local mode has no Keycloak at all
  assert.equal(c.clientId, "personal-agent-browser");
  assert.equal(c.deviceAuthEndpoint, "https://pa.test/api/v1/auth/device/code");
});

test("parseClientConfig rejects an oidc config without an issuer", () => {
  assert.throws(() => parseClientConfig({ auth_mode: "oidc" }), AuthError);
});

test("resolveDeviceEndpoints prefers the advertised URLs", () => {
  const e = resolveDeviceEndpoints({
    serverUrl: "https://pa.test",
    issuer: "https://kc.test/realms/pa",
    deviceAuthEndpoint: "https://pa.test/api/v1/auth/device/code",
    deviceTokenEndpoint: "https://pa.test/api/v1/auth/device/token",
  });
  assert.deepEqual(e, {
    deviceAuthorization: "https://pa.test/api/v1/auth/device/code",
    deviceToken: "https://pa.test/api/v1/auth/device/token",
  });
});

test("resolveDeviceEndpoints falls back to the Keycloak-derived URLs on an old backend", () => {
  const e = resolveDeviceEndpoints({ serverUrl: "https://pa.test", issuer: "https://kc.test/realms/pa/" });
  assert.deepEqual(e, {
    deviceAuthorization: "https://kc.test/realms/pa/protocol/openid-connect/auth/device",
    deviceToken: "https://kc.test/realms/pa/protocol/openid-connect/token",
  });
});

test("resolveDeviceEndpoints resolves a relative endpoint against the server URL and errors with nothing to go on", () => {
  const e = resolveDeviceEndpoints({
    serverUrl: "https://pa.test",
    deviceAuthEndpoint: "/api/v1/auth/device/code",
    deviceTokenEndpoint: "/api/v1/auth/device/token",
  });
  assert.equal(e.deviceToken, "https://pa.test/api/v1/auth/device/token");
  assert.throws(() => resolveDeviceEndpoints({ serverUrl: "https://pa.test" }), AuthError);
});

// ---------- device grant ----------

test("startDeviceAuthorization normalizes the response and defaults the interval", async () => {
  const f = fakeFetch([
    {
      status: 200,
      body: {
        device_code: "dc",
        user_code: "WDJB-MJHT",
        verification_uri: "https://pa.test/activate",
        verification_uri_complete: "https://pa.test/activate?code=WDJB-MJHT",
      },
    },
  ]);
  const d = await startDeviceAuthorization({
    fetchImpl: f,
    endpoint: "https://pa.test/api/v1/auth/device/code",
    clientId: "personal-agent-browser",
  });
  assert.equal(d.deviceCode, "dc");
  assert.equal(d.userCode, "WDJB-MJHT");
  assert.equal(d.verificationUriComplete, "https://pa.test/activate?code=WDJB-MJHT");
  assert.equal(d.interval, 5);
  assert.equal(f.calls[0].body.client_id, "personal-agent-browser");
});

test("devicePollOutcome classifies every documented response", () => {
  assert.deepEqual(devicePollOutcome(400, { error: "authorization_pending" }), { action: "pending" });
  assert.deepEqual(devicePollOutcome(400, { error: "slow_down" }), { action: "slow_down" });
  assert.equal(devicePollOutcome(400, { error: "access_denied" }).action, "fail");
  assert.equal(devicePollOutcome(400, { error: "expired_token" }).code, "expired_token");
  assert.equal(devicePollOutcome(200, { access_token: "at" }).action, "token");
  assert.equal(devicePollOutcome(500, {}).action, "fail");
});

test("pollDeviceToken keeps polling on authorization_pending, backs off on slow_down, then resolves", async () => {
  const f = fakeFetch([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 300 } },
  ]);
  const sleep = fakeSleep();
  const t = await pollDeviceToken({
    fetchImpl: f,
    endpoint: "https://pa.test/api/v1/auth/device/token",
    clientId: "c",
    deviceCode: "dc",
    interval: 5,
    sleep,
  });
  assert.equal(t.access_token, "at");
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].body.grant_type, DEVICE_CODE_GRANT);
  assert.equal(f.calls[0].body.device_code, "dc");
  // The server's interval is honoured, and slow_down grows it by RFC 8628's +5 s for every
  // subsequent poll (the server grows its own and would keep rejecting us otherwise).
  assert.deepEqual(sleep.delays, [5000, 5000, 10000, 10000]);
});

test("pollDeviceToken terminates on access_denied and on expired_token", async () => {
  const sleep = fakeSleep();
  const args = {
    endpoint: "https://pa.test/t",
    clientId: "c",
    deviceCode: "dc",
    interval: 1,
    sleep,
  };
  await assert.rejects(
    pollDeviceToken({ ...args, fetchImpl: fakeFetch([{ status: 400, body: { error: "access_denied" } }]) }),
    (e) => e instanceof AuthError && e.code === "access_denied",
  );
  await assert.rejects(
    pollDeviceToken({ ...args, fetchImpl: fakeFetch([{ status: 400, body: { error: "expired_token" } }]) }),
    (e) => e.code === "expired_token",
  );
});

test("pollDeviceToken gives up once the code's lifetime is over", async () => {
  let t = 0;
  await assert.rejects(
    pollDeviceToken({
      fetchImpl: fakeFetch([]),
      endpoint: "https://pa.test/t",
      clientId: "c",
      deviceCode: "dc",
      interval: 5,
      expiresIn: 10,
      sleep: async () => {
        t += 20000;
      },
      now: () => t,
    }),
    (e) => e.code === "expired_token",
  );
});

// ---------- single-flight refresh ----------

test("two concurrent refreshes issue exactly ONE token request and share the new token", async () => {
  // Refresh tokens are single-use + rotated: a second request with the same token would look like
  // a replay (theft) to the backend and revoke every session of the user.
  const f = fakeFetch([
    { status: 200, body: { access_token: "at2", refresh_token: "rt2", expires_in: 300 } },
  ]);
  const stored = { refresh_token: "rt1" };
  const refresh = createSingleFlightRefresh({
    fetchImpl: f,
    getSession: async () => ({
      endpoint: "https://pa.test/api/v1/auth/device/token",
      clientId: "c",
      refreshToken: stored.refresh_token,
    }),
    saveTokens: async (patch) => Object.assign(stored, patch),
  });

  const [a, b] = await Promise.all([refresh(), refresh()]);
  assert.equal(f.calls.length, 1, "the rotated refresh token must be sent exactly once");
  assert.equal(a, "at2");
  assert.equal(b, "at2");
  assert.equal(f.calls[0].body.grant_type, "refresh_token");
  assert.equal(f.calls[0].body.refresh_token, "rt1");
  // The rotation is persisted before the access token is handed out.
  assert.equal(stored.refresh_token, "rt2");
});

test("a refresh after the in-flight one completed uses the ROTATED token", async () => {
  const f = fakeFetch([
    { status: 200, body: { access_token: "at2", refresh_token: "rt2", expires_in: 300 } },
    { status: 200, body: { access_token: "at3", refresh_token: "rt3", expires_in: 300 } },
  ]);
  const stored = { refresh_token: "rt1" };
  const refresh = createSingleFlightRefresh({
    fetchImpl: f,
    getSession: async () => ({
      endpoint: "https://pa.test/t",
      clientId: "c",
      refreshToken: stored.refresh_token,
    }),
    saveTokens: async (patch) => Object.assign(stored, patch),
  });
  assert.equal(await refresh(), "at2");
  assert.equal(await refresh(), "at3");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((c) => c.body.refresh_token),
    ["rt1", "rt2"],
  );
});

test("a rejected refresh is not cached: invalid_grant surfaces its code and the next call retries", async () => {
  const f = fakeFetch([
    { status: 400, body: { error: "invalid_grant" } },
    { status: 200, body: { access_token: "at9", refresh_token: "rt9", expires_in: 300 } },
  ]);
  const stored = { refresh_token: "rt1" };
  const refresh = createSingleFlightRefresh({
    fetchImpl: f,
    getSession: async () => ({ endpoint: "https://pa.test/t", clientId: "c", refreshToken: stored.refresh_token }),
    saveTokens: async (patch) => Object.assign(stored, patch),
  });
  await assert.rejects(refresh(), (e) => e instanceof AuthError && e.code === "invalid_grant");
  assert.equal(await refresh(), "at9");
});

test("refresh without a stored token asks for an interactive sign-in", async () => {
  const f = fakeFetch([]);
  const refresh = createSingleFlightRefresh({
    fetchImpl: f,
    getSession: async () => ({ endpoint: "https://pa.test/t", clientId: "c", refreshToken: null }),
    saveTokens: async () => {},
  });
  await assert.rejects(refresh(), (e) => e.code === "signin_required");
  assert.equal(f.calls.length, 0);
});
