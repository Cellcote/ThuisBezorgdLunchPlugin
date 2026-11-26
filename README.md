# ThuisBezorgd Lunch Filter

Browser extension for [thuisbezorgd.nl](https://www.thuisbezorgd.nl) that filters the
restaurant list for lunch (< 1.5 km, open 12:00–14:00, sorted by distance, no promo
banners) and shows where colleagues ordered today.

Colleagues' orders are stored by a small UiPath solution (`backend/LunchOrders`: two API
workflows on Data Fabric). The extension signs in to UiPath with OAuth (authorization
code + PKCE) from its background script and calls those workflows.

Available for **Chrome** (and other Chromium browsers) and **Firefox**.

## Install

Download the packages from the [latest release](../../releases/latest).

- **Chrome**: unzip `lunch-filter-chrome-<version>.zip`, open `chrome://extensions`,
  turn on *Developer mode*, then *Load unpacked* and pick the unzipped folder.
- **Firefox**: open `lunch-filter-firefox-<version>.xpi` (signed builds only) in Firefox.
  An unsigned `.zip` can only be loaded temporarily via `about:debugging` →
  *This Firefox* → *Load Temporary Add-on*.

## Development

Requires Node 22 (see `.nvmrc`).

```sh
npm ci
npm run ci          # lint + manifest check + build + Firefox lint
```

The repo root is a loadable Chrome extension (`manifest.json` is the Chrome manifest).
`npm run build` writes to `dist/`:

| Output | What |
| --- | --- |
| `dist/chrome/`, `dist/lunch-filter-chrome-<v>.zip` | Chrome package, manifest as-is |
| `dist/firefox/`, `dist/lunch-filter-firefox-<v>.zip` | Firefox package with a generated manifest |

The Firefox manifest is generated in `scripts/build.mjs`: it drops the Chrome-only `key`,
uses `background.scripts` instead of a service worker, and sets the add-on ID
`thuisbezorgd-lunch-filter@cellcote`. When you add a file to the extension, add it to
`FILES` in that script too; the build fails if the manifest references a missing file.

### OAuth redirect URIs

The UiPath External App must list both redirect URIs:

- Chrome: `https://<extension-id>.chromiumapp.org/` (ID is pinned by `key` in `manifest.json`)
- Firefox: `https://386a4b7688772ba6264c43ca73a1e0b17369d04c.extensions.allizom.org/`
  (derived from the add-on ID; don't change the ID)

## Releasing

1. Bump `version` in `manifest.json` and commit.
2. Tag and push: `git tag v3.0.2 && git push origin v3.0.2`

The **Release** workflow checks that the tag matches the manifest version, lints, builds
both packages and attaches them to a GitHub release.

Firefox only installs signed add-ons permanently. To sign, create AMO API keys at
<https://addons.mozilla.org/developers/addon/api/key/> and add them as secrets
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the `release` environment. The workflow then signs
the add-on as *unlisted* (self-distributed, not on the AMO store) and attaches the `.xpi`.
Without the secrets, the release has only the unsigned Firefox zip.

## Backend

`backend/LunchOrders` is a UiPath solution, managed with the `uip` CLI (see its
`AGENTS.md`). It is not deployed by CI. The Data Fabric connection resource and the process resources
(`resources/solution_folder/connection/` and `process/`) are not committed: the connection is
named after the account that created it and the process resources reference it. After cloning, run `uip solution resources refresh` in
`backend/LunchOrders` (signed in with `uip login`) to recreate them from the projects'
`bindings_v2.json` before packing.
