import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost, secureUrlKind, hostOf, matchesBlockedOrigin } from "../urls.js";

test("isLoopbackHost recognizes the localhost spellings", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "127.0.0.2", "localhost.evil.com", ""]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("secureUrlKind enforces https except on loopback", () => {
  assert.equal(secureUrlKind("https://pa.example.com"), "ok");
  assert.equal(secureUrlKind("http://localhost:8080"), "ok");
  assert.equal(secureUrlKind("http://127.0.0.1"), "ok");
  assert.equal(secureUrlKind("http://app.localhost/x"), "ok");
  assert.equal(secureUrlKind("http://pa.example.com"), "insecure");
  assert.equal(secureUrlKind("not a url"), "invalid");
  assert.equal(secureUrlKind(""), "invalid");
});

test("hostOf returns the lower-cased hostname or empty string", () => {
  assert.equal(hostOf("https://PA.Example.com/path"), "pa.example.com");
  assert.equal(hostOf("about:blank"), "");
  assert.equal(hostOf("garbage"), "");
});

test("matchesBlockedOrigin blocks the host and its subdomains", () => {
  const blocked = ["https://pa.example.com", "auth.example.com"];
  // exact host (full URL entry) + subdomains
  assert.equal(matchesBlockedOrigin("https://pa.example.com/chat", blocked), true);
  assert.equal(matchesBlockedOrigin("https://api.pa.example.com/x", blocked), true);
  // bare-host entry + ignores scheme/port
  assert.equal(matchesBlockedOrigin("https://auth.example.com/realms/x", blocked), true);
  assert.equal(matchesBlockedOrigin("http://auth.example.com:8443", blocked), true);
  // unrelated hosts and a near-miss suffix are allowed
  assert.equal(matchesBlockedOrigin("https://example.com", blocked), false);
  assert.equal(matchesBlockedOrigin("https://notpa.example.com", blocked), false);
  assert.equal(matchesBlockedOrigin("https://evil-pa.example.com.attacker.test", blocked), false);
  // non-web / unparseable targets never match
  assert.equal(matchesBlockedOrigin("about:blank", blocked), false);
  assert.equal(matchesBlockedOrigin("https://anything.test", []), false);
});
