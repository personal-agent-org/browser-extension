#!/usr/bin/env node
// Build loadable/packable extension dirs from the shared source: shared files are copied
// verbatim, the per-target manifest is written as manifest.json. Run: node build.mjs
// → dist/chrome + dist/firefox. (For Chrome dev you can also "Load unpacked" this folder.)
import { cp, mkdir, rm, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SHARED = [
  "background.js",
  "tools.js",
  "cdp.js",
  "platform.js",
  "popup.html",
  "popup.js",
  "icons",
  "_locales",
];
const TARGETS = {
  chrome: "manifest.json",
  firefox: "manifest.firefox.json",
};

for (const [target, manifest] of Object.entries(TARGETS)) {
  const out = join(root, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const f of SHARED) {
    await cp(join(root, f), join(out, f), { recursive: true });
  }
  await copyFile(join(root, manifest), join(out, "manifest.json"));
  console.log(`built dist/${target}`);
}
