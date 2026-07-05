# Noridoc: scripts

Path: @/scripts

### Overview

- Release tooling for cutting a `nori-slack-cli` npm release by pushing a git tag
- Holds the pure tag-naming contract ([release-tag.mjs](release-tag.mjs)) and the `npm run release` command that preflight-checks the tree and pushes the tag ([create-release.mjs](create-release.mjs))

### How it fits into the larger codebase

- These scripts are the human-facing entry point to the version model documented in [../docs.md](../docs.md): the git tag is the source of truth, so a release is cut by tagging rather than by editing a version
- `create-release.mjs` is wired to `npm run release` in [../package.json](../package.json). It pushes a `slack-cli-v<version>` tag, which triggers [../.github/workflows/slack-cli-release.yml](../.github/workflows/slack-cli-release.yml) to stamp, build, and publish that version to npm
- `release-tag.mjs` is the shared tag contract. Its `STABLE_SEMVER` regex is intentionally kept in sync with the version validation inside the release workflow -- both reject prerelease suffixes so releases are stable-only
- The tag helper is unit-tested in [../test/release-tag.test.ts](../test/release-tag.test.ts), which runs as part of the normal `npm test` suite

### Core Implementation

- **`release-tag.mjs`** -- exports `TAG_PREFIX` (`slack-cli-v`) and `releaseTagFor(version)`. The function validates the version against a stable `X.Y.Z` regex and returns the prefixed tag, throwing on anything that carries a leading `v`, a prerelease suffix, or is not semver. It is a pure function so it can be imported by both the CLI script and the test without side effects
- **`create-release.mjs`** -- the `npm run release -- <version>` command. It validates the version at the CLI boundary (turning a bad input into a clean message rather than a stack trace), then preflight-checks that the branch is `main`, the working tree is clean, local `main` matches `origin/main`, and the tag does not already exist. Only then does it create an annotated tag and push it. It shells out to `git` via `execFileSync`

### Things to Know

- The scripts are `.mjs` (plain Node ES modules) rather than TypeScript, so they run without a build step and can be imported directly by both the workflow-adjacent tooling and the Vitest test
- `create-release.mjs` refuses to release from anywhere but a clean, up-to-date `main` -- this is a guard so the published version always corresponds to committed, pushed code
- The version regex lives in two places by necessity ([release-tag.mjs](release-tag.mjs) and the release workflow's shell validation); they must stay in sync

Created and maintained by Nori.
