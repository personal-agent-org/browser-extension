#!/usr/bin/env node
// Build loadable/packable extension dirs from the shared source. Shared files are copied verbatim;
// each target's manifest.json is assembled from manifest.base.json + manifest.<target>.json so the
// common fields (name, description, icons, action, host_permissions) live in exactly one place and
// the version is sourced from package.json. Run: node build.mjs → dist/chrome + dist/firefox.
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SHARED = [
  "background.js",
  "tools.js",
  "cdp.js",
  "platform.js",
  "urls.js",
  "popup.html",
  "popup.js",
  "icons",
  "_locales",
];
const TARGETS = ["chrome", "firefox"];

const readJson = async (rel) => JSON.parse(await readFile(join(root, rel), "utf8"));

const base = await readJson("manifest.base.json");
const { version } = await readJson("package.json");

for (const target of TARGETS) {
  const patch = await readJson(`manifest.${target}.json`);
  // Scalars/objects: patch overrides base. permissions: union of both (Chrome adds `debugger`).
  const manifest = {
    ...base,
    ...patch,
    version,
    permissions: [...new Set([...(base.permissions || []), ...(patch.permissions || [])])],
  };
  const out = join(root, "dist", target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const f of SHARED) {
    await cp(join(root, f), join(out, f), { recursive: true });
  }
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built dist/${target}`);
}
