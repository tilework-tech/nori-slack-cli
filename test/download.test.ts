import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli, startFakeBroker, type FakeBroker } from './helpers.js';

describe('download command (proxy mode)', () => {
  let broker: FakeBroker;
  let dir: string;

  beforeEach(async () => {
    broker = await startFakeBroker();
    dir = mkdtempSync(path.join(tmpdir(), 'nori-slack-download-'));
  });

  afterEach(async () => {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function proxyEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NORI_SLACK_PROXY_URL: broker.url,
      NORI_SLACK_CONTEXT_TOKEN: 'ctx-token-123',
      ...extra,
    };
  }

  // Binary bytes (multi-byte UTF-8, a NUL, and 0xff) whose character length
  // differs from the byte length. They prove the bytes the broker streams reach
  // the output file unchanged (no transcoding) via the equals() check.
  const fileBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xc3, 0xa9, 0x00, 0xff]);

  it('GETs the broker download endpoint with the context token and writes the exact bytes', async () => {
    const outPath = path.join(dir, 'out.bin');
    broker.queueDownloadResponse({ body: fileBytes, contentType: 'application/pdf' });

    const result = await runCli(
      ['download', '--id', 'F123', '--output', outPath],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.file_id).toBe('F123');
    expect(output.bytes).toBe(fileBytes.length);

    expect(broker.downloads).toHaveLength(1);
    expect(broker.downloads[0].url).toContain('/slack-proxy/download');
    expect(broker.downloads[0].url).toContain('file=F123');
    expect(broker.downloads[0].headers.authorization).toBe('Bearer ctx-token-123');

    expect(readFileSync(outPath).equals(fileBytes)).toBe(true);
  });

  it('maps a broker 403 to a structured error and writes no file', async () => {
    const outPath = path.join(dir, 'denied.bin');
    broker.queueDownloadResponse({
      status: 403,
      body: Buffer.from(
        JSON.stringify({ error: 'Slack file is not shared in this session conversation' }),
      ),
      contentType: 'application/json',
    });

    const result = await runCli(
      ['download', '--id', 'F999', '--output', outPath],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('not shared');
    expect(result.stderr).toContain('Error:');
    expect(existsSync(outPath)).toBe(false);
  });

  it('maps a broker 404 to a structured error and writes no file', async () => {
    const outPath = path.join(dir, 'missing.bin');
    broker.queueDownloadResponse({
      status: 404,
      body: Buffer.from(JSON.stringify({ error: 'Slack file not found' })),
      contentType: 'application/json',
    });

    const result = await runCli(
      ['download', '--id', 'Fnope', '--output', outPath],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('not found');
    expect(existsSync(outPath)).toBe(false);
  });

  it('maps a broker 401 to a context-token suggestion', async () => {
    const outPath = path.join(dir, 'unauth.bin');
    broker.queueDownloadResponse({
      status: 401,
      body: Buffer.from(JSON.stringify({ error: 'Unauthorized' })),
      contentType: 'application/json',
    });

    const result = await runCli(
      ['download', '--id', 'F123', '--output', outPath],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.suggestion).toContain('NORI_SLACK_CONTEXT_TOKEN');
    expect(existsSync(outPath)).toBe(false);
  });

  it('exits 2 without contacting the broker when --id is missing', async () => {
    const result = await runCli(
      ['download', '--output', path.join(dir, 'x.bin')],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message.toLowerCase()).toContain('id');
    expect(broker.downloads).toHaveLength(0);
  });

  it('exits 2 without contacting the broker when --output is missing', async () => {
    const result = await runCli(['download', '--id', 'F123'], proxyEnv());

    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message.toLowerCase()).toContain('output');
    expect(broker.downloads).toHaveLength(0);
  });

  it('--dry-run reports the plan without contacting the broker', async () => {
    const outPath = path.join(dir, 'out.bin');
    const result = await runCli(
      ['download', '--id', 'F123', '--output', outPath, '--dry-run'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dry_run).toBe(true);
    expect(output.command).toBe('download');
    expect(output.file_id).toBe('F123');
    expect(output.output).toBe(outPath);
    expect(output.transport).toBe('proxy');
    expect(broker.downloads).toHaveLength(0);
    expect(existsSync(outPath)).toBe(false);
  });
});
