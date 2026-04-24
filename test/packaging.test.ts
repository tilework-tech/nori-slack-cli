import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('Package install from tarball', () => {
  let sourceDir: string;
  let packDir: string;
  let installDir: string;
  let tarballPath: string;

  beforeAll(() => {
    sourceDir = mkdtempSync(path.join(tmpdir(), 'nori-slack-source-'));
    packDir = mkdtempSync(path.join(tmpdir(), 'nori-slack-pack-'));
    installDir = mkdtempSync(path.join(tmpdir(), 'nori-slack-install-'));

    copyFileSync(path.join(PROJECT_ROOT, 'package.json'), path.join(sourceDir, 'package.json'));
    copyFileSync(path.join(PROJECT_ROOT, 'tsconfig.json'), path.join(sourceDir, 'tsconfig.json'));
    copyFileSync(path.join(PROJECT_ROOT, 'README.md'), path.join(sourceDir, 'README.md'));
    copyFileSync(path.join(PROJECT_ROOT, 'LICENSE'), path.join(sourceDir, 'LICENSE'));
    cpSync(path.join(PROJECT_ROOT, 'src'), path.join(sourceDir, 'src'), { recursive: true });
    symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(sourceDir, 'node_modules'));

    execFileSync('npm', ['pack', '--pack-destination', packDir], {
      cwd: sourceDir,
      stdio: 'pipe',
    });

    const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack did not produce a .tgz');
    tarballPath = path.join(packDir, tarball);

    execFileSync('npm', ['init', '-y'], { cwd: installDir, stdio: 'pipe' });
    execFileSync('npm', ['install', '--no-save', tarballPath], {
      cwd: installDir,
      stdio: 'pipe',
    });
  }, 180000);

  afterAll(() => {
    if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
    if (packDir) rmSync(packDir, { recursive: true, force: true });
    if (installDir) rmSync(installDir, { recursive: true, force: true });
  });

  it('installs a working nori-slack binary that lists methods', { timeout: 30000 }, () => {
    const binPath = path.join(installDir, 'node_modules', '.bin', 'nori-slack');
    expect(existsSync(binPath)).toBe(true);

    const output = execFileSync(binPath, ['list-methods', '--namespace', 'chat'], {
      cwd: installDir,
      env: { ...process.env, SLACK_BOT_TOKEN: '' },
      encoding: 'utf-8',
    });

    const parsed = JSON.parse(output);
    expect(parsed.namespace).toBe('chat');
    expect(parsed.methods).toContain('chat.postMessage');
  });
});
