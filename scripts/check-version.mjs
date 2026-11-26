// Validates manifest.json and, when a version tag is given (argument or
// GITHUB_REF_NAME on a tag build), checks it matches manifest.version.
//
//   node scripts/check-version.mjs          # validate only
//   node scripts/check-version.mjs v3.0.1   # also require tag == v<version>

import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const fail = (msg) => {
  console.error(`check-version: ${msg}`);
  process.exit(1);
};

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  fail(`version "${manifest.version}" must be 1-4 dot-separated integers (Chrome/Firefox rule)`);
}

const tag =
  process.argv[2] ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag && tag !== `v${manifest.version}`) {
  fail(`tag ${tag} does not match manifest version v${manifest.version}; bump manifest.json first`);
}
console.log(`manifest OK, version ${manifest.version}${tag ? `, matches tag ${tag}` : ""}`);
