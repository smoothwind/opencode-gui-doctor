# Releasing

This repo ships two things automatically from GitHub Actions:

| Target | Workflow | Trigger |
| --- | --- | --- |
| Docs site → GitHub Pages | `.github/workflows/pages.yml` | push to `main` touching `docs/**` or the workflow itself |
| Package → npm | `.github/workflows/publish.yml` | push of a `v*` tag |
| Package → npm (one-click) | `.github/workflows/release.yml` | manual `workflow_dispatch` |

## One-time setup

### 1. Enable GitHub Pages

Creating a Pages site is a **repository-administration** operation, so the
automatic `GITHUB_TOKEN` can never do it — `configure-pages` will fail with
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

Set `enablement: true` (with a `PAGES_TOKEN` secret that has `repo` scope, or
fine-grained `Pages:write` + `Administration:write`) only if you want CI to
create the Pages site on a brand-new repo. The committed workflow already wires
this up conditionally and is a no-op when the secret is absent.

### 2. Add the npm token

> **Settings → Secrets and variables → Actions → New repository secret**
> Name `NPM_TOKEN`, value an npm **Automation** token (npmjs.com → Access
> Tokens → Generate New Token → *Automation*) with publish rights on this
> package.

npm publishes are signed with provenance (OIDC), so the workflows set
`id-token: write`; no long-lived credentials beyond `NPM_TOKEN` are needed.

## Releasing

### Option A — one-click (recommended)

Actions → **Release** → **Run workflow**:

- `version`: `patch` | `minor` | `major` | an explicit `x.y.z`

The workflow typechecks, runs `npm version`, commits, pushes `main` and the
`v<version>` tag, then publishes with provenance.

> This exists as a single run on purpose: a tag pushed with the workflow's
> `GITHUB_TOKEN` **does not** trigger another workflow (GitHub suppresses
> workflow runs caused by `GITHUB_TOKEN` to prevent recursion), so an
> "auto-tag on version bump" step would silently never publish.

### Option B — manual tag

```bash
# bump package.json (and package-lock.json) to X.Y.Z first
git commit -am "release: vX.Y.Z"
git tag -a vX.Y.Z -m "opencode-gui-doctor vX.Y.Z"
git push origin main
git push origin vX.Y.Z     # triggers "Publish to npm"
```

The publish workflow refuses to run if the pushed tag does not match
`package.json`'s `version`.

## Versioning policy

- SemVer; `0.x` while the API stabilises.
- Add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` in the same commit
  that bumps the version.
- `scripts/release.mjs` (`npm run release`) is a local alternative that bumps the
  patch version, packs, and optionally installs the tarball globally for
  dogfooding — it does **not** publish to the registry.

## Verifying a release

```bash
npm view opencode-gui-doctor version
npx opencode-gui-doctor env      # or: gui-doctor env, after a global install
```

Site: <https://smoothwind.github.io/opencode-gui-doctor/>
