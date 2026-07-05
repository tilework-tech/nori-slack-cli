#!/usr/bin/env node
// Cut a nori-slack-cli release by pushing a `slack-cli-v<version>` tag, which
// triggers .github/workflows/slack-cli-release.yml to publish to npm.
//
// Usage: npm run release -- <version>       e.g. npm run release -- 0.5.0
//
// package.json carries a placeholder version (0.0.0); the tag is the source of
// truth for the released version.

import { execFileSync } from 'node:child_process';
import { releaseTagFor } from './release-tag.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const version = process.argv[2];
if (!version) {
  fail('Usage: npm run release -- <version>   (e.g. npm run release -- 0.5.0)');
}

// Validate the version at the CLI boundary so the user gets a clean message
// rather than a stack trace.
let tag;
try {
  tag = releaseTagFor(version);
} catch (err) {
  fail(err.message);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  fail(`Refusing to release from "${branch}": releases are cut from main.`);
}

if (git(['status', '--porcelain'])) {
  fail('Refusing to release: working tree is not clean. Commit or stash first.');
}

git(['fetch', 'origin', 'main', '--tags']);
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'origin/main'])) {
  fail('Refusing to release: local main is out of sync with origin/main. Pull/push first.');
}

if (git(['tag', '--list', tag])) {
  fail(`Tag ${tag} already exists.`);
}

git(['tag', '-a', tag, '-m', `nori-slack-cli release ${version}`]);
git(['push', 'origin', tag]);

console.log(`Pushed ${tag}. The release workflow will publish nori-slack-cli@${version} to npm.`);
