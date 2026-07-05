import { describe, it, expect } from 'vitest';
import { releaseTagFor } from '../scripts/release-tag.mjs';

describe('releaseTagFor', () => {
  it('builds a prefixed tag from a stable semver version', () => {
    expect(releaseTagFor('0.5.0')).toBe('slack-cli-v0.5.0');
  });

  it('rejects a prerelease version (stable releases only)', () => {
    expect(() => releaseTagFor('1.2.3-rc.1')).toThrow(/invalid version/i);
  });

  it('rejects the 0.0.0 placeholder version', () => {
    expect(() => releaseTagFor('0.0.0')).toThrow(/invalid version "0\.0\.0"/i);
  });

  it('rejects a version that already carries a leading v', () => {
    expect(() => releaseTagFor('v0.5.0')).toThrow(/invalid version/i);
  });

  it('rejects a non-semver version', () => {
    expect(() => releaseTagFor('0.5')).toThrow(/invalid version/i);
    expect(() => releaseTagFor('banana')).toThrow(/invalid version/i);
  });
});
