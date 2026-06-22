// Pure URL/security helpers shared by the service worker (background.js), the popup (popup.js)
// and the tool layer (tools.js). Deliberately dependency-free (no WebExtension `api`, no DOM) so
// it loads in every context AND can be unit-tested under plain Node (see test/urls.test.js).

// localhost in its various spellings — the only host where cleartext http is tolerated.
export function isLoopbackHost(h) {
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    (typeof h === "string" && h.endsWith(".localhost"))
  );
}

// Classify a URL's transport without formatting a message, so each caller can render its own
// (the popup localizes via i18n; the background throws plain Errors):
//   "ok"        — https, or http on loopback
//   "invalid"   — not a parseable URL
//   "insecure"  — http on a non-loopback host (would leak the bearer/refresh token in clear)
export function secureUrlKind(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return "invalid";
  }
  if (u.protocol === "https:") return "ok";
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return "ok";
  return "insecure";
}

// Lower-cased hostname of a URL (or "" if it doesn't parse).
export function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Does `url` fall under any blocked entry? An entry may be a full origin/URL or a bare host; both
// match by host OR subdomain (a blocked host blocks every scheme/port/subdomain under it — the
// conservative choice for the app origin + IdP, which must never be driven by the agent).
export function matchesBlockedOrigin(url, blocked) {
  const h = hostOf(url);
  if (!h) return false; // about:blank / chrome:// — the platform already forbids scripting there
  for (const b of blocked || []) {
    const entry = String(b || "").trim().toLowerCase();
    if (!entry) continue;
    const bh = hostOf(entry.includes("://") ? entry : "https://" + entry);
    if (bh && (h === bh || h.endsWith("." + bh))) return true;
  }
  return false;
}
