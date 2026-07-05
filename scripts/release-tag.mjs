// Shared release-tag contract for nori-slack-cli.
//
// Stable and prerelease git tags drive the publish workflow
// (.github/workflows/slack-cli-release.yml). A tag is the release version
// prefixed with `slack-cli-v`, matching the sibling nori-skillsets convention.

export const TAG_PREFIX = 'slack-cli-v';

// Stable X.Y.Z only (no prerelease suffix). Kept in sync with the version
// validation in slack-cli-release.yml.
const STABLE_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function releaseTagFor(version) {
  if (version === '0.0.0') {
    throw new Error(`Invalid version "${version}": 0.0.0 is the package.json placeholder, not a release version`);
  }
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`Invalid version "${version}": expected a stable semver like 1.2.3`);
  }
  return `${TAG_PREFIX}${version}`;
}
