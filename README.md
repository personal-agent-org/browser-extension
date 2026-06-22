# Personal Agent — Browser extension (Chrome + Firefox, MV3)

Connects your browser to [Personal Agent](https://github.com/personal-agent-org) as a
`kind=browser` device, so the assistant can read and drive pages in *your* logged-in session. It
announces `browser_*` tools (navigate, click, type, scroll, read page, screenshot, …) over the
backend's device gateway; every call is gated by the chat's security mode.

## Install

- **Chrome:** from the [Chrome Web Store](https://chromewebstore.google.com/detail/adbdjcoeniffkccejdnmmadhilncdadd).
- **Unpacked / Firefox:** build it (below), then load it.

Open the popup, enter your **Server URL**, and click **Connect (sign in)**. A **Browser** device
then appears under *Settings → Devices* in the app — select it in a chat.

## Build

```bash
node build.mjs    # writes dist/chrome and dist/firefox
```

- **Chrome:** `chrome://extensions` → *Developer mode* → *Load unpacked* → `dist/chrome` (or this folder).
- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on* → `dist/firefox/manifest.json`.

`platform.js` selects the `browser`/`chrome` namespace; `_locales/` holds the WebExtension i18n
(`en` source, translated via Weblate). The Chrome DevTools-Protocol tools (`cdp.js`) are
Chromium-only.

## Documentation

- **Using it** — the tools, debug mode, and safety controls:
  [Devices & apps → The browser extension](https://pa.luebke.dev/docs/features/devices/#the-browser-extension)
- **Self-hosting** — your own Keycloak client, redirect URI, and extension ID:
  [Self-hosting → Browser extension](https://pa.luebke.dev/docs/self-hosting/#browser-extension-chrome-mv3)

## License

[MIT](LICENSE).
