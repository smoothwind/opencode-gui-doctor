# Releasing

This project is distributed **from GitHub only** — nothing is published to the
npm registry. Two workflows take care of the GitHub side:

| Target | Workflow | Trigger |
| --- | --- | --- |
| Docs site → GitHub Pages | `.github/workflows/pages.yml` | push to `main` touching `docs/**` or the workflow itself |
| GitHub Release | `.github/workflows/release.yml` | push of a `v*` tag |

## One-time setup: enable GitHub Pages

Creating a Pages site is a **repository-administration** operation, so the
automatic `GITHUB_TOKEN` can never do it — `configure-pages` fails with
`Get Pages site failed ... Not Found` until the site exists.

Enable it **once**, in the browser:

> **Settings → Pages → Build and deployment → Source → `GitHub Actions`**

Then re-run the *Deploy GitHub Pages* workflow (Actions → the run → **Re-run all
jobs**, or **Run workflow** via `workflow_dispatch`). Afterwards the standard
`configure-pages → upload-pages-artifact → deploy-pages` chain works with the
default token forever.

> If the Pages settings page offers no "GitHub Actions" source, the repo is
> probably **private on the Free plan** (Pages for private repos needs
> Pro/Team/Enterprise). Make the repo public or upgrade.

The workflow still supports an optional `PAGES_TOKEN` secret to auto-create the
site from CI (classic PAT with `repo` scope, or fine-grained `Pages:write` +
`Administration:write`). It is a no-op when the secret is absent — the manual
toggle above is the normal path.

## Cutting a release

1. Bump the version and add a changelog entry, in one commit:

   ```bash
   # edit package.json "version" -> X.Y.Z, and package-lock.json to match
   # add a "## [X.Y.Z] - YYYY-MM-DD" section to CHANGELOG.md
   git commit -am "release: vX.Y.Z"
   ```

   (`npm version patch --no-git-tag-version` also works if you have npm on
   hand; it keeps `package.json` and `package-lock.json` in sync.)

2. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m "opencode-gui-doctor vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

3. The **Release** workflow runs: it verifies the tag matches `package.json`'s
   `version`, then creates a GitHub Release with auto-generated notes. Docs are
   unaffected unless `docs/**` changed.

No token or secret is needed for the Release workflow — it uses the default
`GITHUB_TOKEN` with `contents: write`.

## Versioning policy

- SemVer; `0.x` while the API stabilises.
- Keep `package.json`, `package-lock.json`, `CHANGELOG.md` and the tag in sync —
  the Release workflow fails if the tag and `package.json` disagree.
- `scripts/release.mjs` (`npm run release`) is a local helper that bumps the
  patch version, packs a tarball, and optionally installs it globally for
  dogfooding. It does **not** publish anything.

## Verifying a release

- Release notes: <https://github.com/smoothwind/opencode-gui-doctor/releases>
- Site: <https://smoothwind.github.io/opencode-gui-doctor/>
