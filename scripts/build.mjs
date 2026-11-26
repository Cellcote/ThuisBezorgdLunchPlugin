// Builds the Chrome and Firefox packages from the same sources.
//
//   dist/chrome/                     unpacked Chrome extension (manifest.json as-is)
//   dist/firefox/                    unpacked Firefox extension (generated manifest)
//   dist/lunch-filter-chrome-<v>.zip
//   dist/lunch-filter-firefox-<v>.zip  (unsigned; see release workflow for signing)

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Every file the extension ships. Keep in sync with manifest.json.
const FILES = ["background.js", "content.js", "styles.css", "icon48.png", "icon128.png"];

// Fixed add-on ID: Firefox derives the identity redirect URL from it, so it must
// never change once the redirect URL is registered with the UiPath External App.
export const GECKO_ID = "thuisbezorgd-lunch-filter@cellcote";

export function firefoxManifest(chrome) {
  const m = structuredClone(chrome);
  delete m.key; // Chrome-only: pins the Chrome extension ID
  m.background = { scripts: [m.background.service_worker] };
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["authenticationInfo", "personallyIdentifyingInfo"],
      },
    },
    // data_collection_permissions needs Firefox for Android 142+
    gecko_android: { strict_min_version: "142.0" },
  };
  return m;
}

async function stage(target, manifest) {
  const dir = path.join(dist, target);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const f of FILES) await cp(path.join(root, f), path.join(dir, f));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return dir;
}

async function pack(target, sourceDir, version) {
  const filename = `lunch-filter-${target}-${version}.zip`;
  await webExt.cmd.build(
    { sourceDir, artifactsDir: dist, filename, overwriteDest: true },
    { shouldExitProgram: false }
  );
  return path.join(dist, filename);
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(manifest.icons),
  ];
  const missing = referenced.filter((f) => !FILES.includes(f));
  if (missing.length) throw new Error(`manifest references files not in FILES: ${missing.join(", ")}`);

  const chromeDir = await stage("chrome", manifest);
  const firefoxDir = await stage("firefox", firefoxManifest(manifest));
  for (const [t, d] of [["chrome", chromeDir], ["firefox", firefoxDir]]) {
    console.log(`built ${path.relative(root, await pack(t, d, manifest.version))}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
