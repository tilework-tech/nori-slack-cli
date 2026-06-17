import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, startFakeBroker, type FakeBroker } from './helpers.js';

describe('files.download', () => {
  let broker: FakeBroker;
  let tmpDir: string;

  beforeEach(async () => {
    broker = await startFakeBroker();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'nori-slack-dl-'));
  });

  afterEach(async () => {
    await broker.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function proxyEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NORI_SLACK_PROXY_URL: broker.url,
      NORI_SLACK_CONTEXT_TOKEN: 'ctx-token-123',
      ...extra,
    };
  }

  it('--output decodes contentBase64 to disk and prints a summary without the base64 blob', async () => {
    const fileBytes = Buffer.from('the-real-file-bytes\x00\x01\x02', 'binary');
    broker.queueResponse({
      body: {
        ok: true,
        file: {
          id: 'F1',
          name: 'icon.png',
          mimetype: 'image/png',
          contentType: 'image/png',
          contentBase64: fileBytes.toString('base64'),
        },
      },
    });

    const outPath = path.join(tmpDir, 'icon.png');
    const result = await runCli(
      ['files.download', '--file', 'F1', '--output', outPath],
      proxyEnv()
    );

    expect(result.exitCode).toBe(0);

    // Request reached the broker as a proper files.download call.
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0].body).toEqual({
      method: 'files.download',
      args: { file: 'F1' },
    });

    // Bytes landed on disk, decoded.
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(fileBytes)).toBe(true);

    // stdout summary describes the written file and omits the base64 blob.
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.file.path).toBe(outPath);
    expect(output.file.bytes).toBe(fileBytes.length);
    expect(output.file.name).toBe('icon.png');
    expect(output.file.contentBase64).toBeUndefined();
  });

  it('is a recognized method — no "not in the known methods list" warning', async () => {
    broker.queueResponse({
      body: { ok: true, file: { id: 'F1', name: 'a.txt', contentBase64: '' } },
    });
    const result = await runCli(['files.download', '--file', 'F1'], proxyEnv());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('known methods list');
  });

  it('errors in direct (SLACK_BOT_TOKEN) mode without contacting Slack', async () => {
    const result = await runCli(
      ['files.download', '--file', 'F1', '--output', path.join(tmpDir, 'x')],
      { SLACK_BOT_TOKEN: 'xoxb-fake-token' }
    );
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.error).toBe('proxy_only_method');
    expect(output.suggestion).toContain('NORI_SLACK_PROXY_URL');
    expect(existsSync(path.join(tmpDir, 'x'))).toBe(false);
  });

  it('describe reports it as a known proxy-only method', async () => {
    const result = await runCli(['describe', 'files.download'], {});
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.known).toBe(true);
    expect(output.description.toLowerCase()).toContain('proxy');
    expect(output.required_params.file).toBeDefined();
  });

  it('list-methods --namespace files includes it', async () => {
    const result = await runCli(['list-methods', '--namespace', 'files'], {});
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.methods).toContain('files.download');
  });
});
