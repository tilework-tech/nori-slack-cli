# Noridoc: GitHub Actions Workflows

Path: @/.github/workflows

### Overview

- CI and release automation for the `nori-slack-cli` npm package
- Two quality-gate CI workflows (`pr-ci.yaml`, `main-ci.yaml`) run build+test on PRs and pushes to `main`; the release workflow (`slack-cli-release.yml`) publishes the package to npm and cuts GitHub Releases
- Releases are stable-only: the git tag is the source of truth for the version, and publishing uses npm OIDC Trusted Publishing (no `NPM_TOKEN` secret)

### How it fits into the larger codebase

- `pr-ci.yaml` and `main-ci.yaml` are the continuous-integration gate: each runs `npm install`, `npm run build`, `npm test` on the Node version pinned in [.nvmrc](../../.nvmrc). They gate every code change but never publish
- `slack-cli-release.yml` is the single publish pipeline. It builds, tests, packs a tarball, publishes to npm, and creates a GitHub Release. It is triggered by pushing a `slack-cli-v*.*.*` tag or by manual `workflow_dispatch`
- The release workflow is the enforcement side of the version model documented in [../../docs.md](../../docs.md): [package.json](../../package.json) ships a `0.0.0` placeholder, and the workflow stamps the real version from the tag before build. It runs the full test suite in [../../test](../../test/), including `packaging.test.ts`, before any publish
- Tags are normally produced by `npm run release -- <version>`, which pushes `slack-cli-v<version>` (see [../../scripts/docs.md](../../scripts/docs.md)). The workflow's version regex is kept in sync with [../../scripts/release-tag.mjs](../../scripts/release-tag.mjs)
- Modeled on the sibling `nori-skillsets` release pattern, trimmed to stable-only (no `@next` prerelease path)

### Core Implementation

`slack-cli-release.yml` has two trigger paths that fan out through a shared job chain:

```
Tag push (slack-cli-v*.*.*)   ──> validate ──> build ──> publish-npm ──> create-release
                                                          (stable @latest)   (GitHub Release)

workflow_dispatch (manual)    ──> validate ──> build ──┬─> dry-run-summary   (dry_run == true)
                                                        └─> publish-npm       (dry_run == false)
```

- **validate** -- derives the version. On a tag push it strips the `slack-cli-v` prefix from `GITHUB_REF_NAME`; on dispatch it uses the required `version` input. It rejects anything that is not a stable `X.Y.Z` and exports `version`, `tag_name`, and the `is_tag_push` flag that downstream jobs gate on
- **build** -- `npm ci`, then `npm version <v> --no-git-tag-version --allow-same-version` to stamp the tag version onto the `0.0.0` placeholder, then `npm run build`, `npm test`, `npm pack`, and uploads the resulting `.tgz` as the `npm-package` artifact
- **publish-npm** -- downloads the tarball, guards against re-publishing an already-live version (`npm view`), and runs `npm publish --tag latest --access public`. It runs in the `npm-publish` GitHub Environment with `id-token: write` so npm OIDC auto-detects the trusted publisher; provenance is generated automatically
- **create-release** -- tag pushes only: auto-generates a changelog from `git log` since the previous `slack-cli-v*` tag and publishes a GitHub Release via `softprops/action-gh-release`, attaching the tarball
- **dry-run-summary** -- dispatch dry-runs only: writes a job summary confirming the build succeeded without publishing

### Things to Know

- **Tag-push detection** uses `github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')`, surfaced as the `is_tag_push` output. This is the canonical way to tell a release run apart from a manual dispatch
- **Publishing is OIDC Trusted Publishing** -- there is no `NPM_TOKEN`/`NODE_AUTH_TOKEN`. This requires the publish job to run on Node 24 (npm 11.5.1+), request `id-token: write`, and run inside the `npm-publish` environment
- **One-time external setup (cannot be scripted)** -- a maintainer must create the `npm-publish` GitHub Environment in this repo and register the trusted publisher on npmjs.com (org `tilework-tech`, repo `nori-slack-cli`, workflow `slack-cli-release.yml`, environment `npm-publish`). npm whitelists a specific workflow file, so all publishing must go through this one file
- **Stable-only** -- unlike `nori-skillsets`, there is no `@next` prerelease path; the version regex and [../../scripts/release-tag.mjs](../../scripts/release-tag.mjs) both reject prerelease suffixes
- `concurrency` groups by `github.ref` and does not cancel in-progress runs, so a release is never interrupted mid-publish
- The two CI workflows (`pr-ci.yaml`, `main-ci.yaml`) are identical except for their trigger (PR to `main` vs. push to `main`) and are unaffected by the release flow

Created and maintained by Nori.
