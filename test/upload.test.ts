import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli, startFakeBroker, type FakeBroker } from './helpers.js';

describe('upload command (proxy mode)', () => {
  let broker: FakeBroker;
  let dir: string;

  beforeEach(async () => {
    broker = await startFakeBroker();
    dir = mkdtempSync(path.join(tmpdir(), 'nori-slack-upload-'));
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

  // Binary bytes (a multi-byte UTF-8 sequence plus a NUL and 0xff) whose
  // character length differs from the byte length. They guard two things: the
  // registered `length` is the raw byte count, and the bytes survive the round
  // trip to the upload host unchanged (no transcoding) via the equals() check.
  const fileBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xc3, 0xa9, 0x00, 0xff]);

  function writeFile(name: string): string {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, fileBytes);
    return filePath;
  }

  it('mints a URL, posts the file bytes, then completes the upload into the channel', async () => {
    const filePath = writeFile('report.pdf');
    broker.queueResponse({
      body: { ok: true, upload_url: `${broker.origin}/upload-external`, file_id: 'F1' },
    });
    broker.queueResponse({
      body: { ok: true, files: [{ id: 'F1', title: 'doc' }] },
    });

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C123', '--title', 'doc'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.files[0].id).toBe('F1');

    expect(broker.requests).toHaveLength(2);
    expect(broker.requests[0].body.method).toBe('files.getUploadURLExternal');
    expect(broker.requests[0].body.args.filename).toBe('report.pdf');
    expect(broker.requests[0].body.args.length).toBe(fileBytes.length);

    expect(broker.uploads).toHaveLength(1);
    expect(broker.uploads[0].url).toContain('upload-external');
    expect(broker.uploads[0].body.equals(fileBytes)).toBe(true);

    expect(broker.requests[1].body.method).toBe('files.completeUploadExternal');
    expect(broker.requests[1].body.args.channel_id).toBe('C123');
    expect(broker.requests[1].body.args.files).toEqual([{ id: 'F1', title: 'doc' }]);
  });

  it('defaults the file title to the filename when --title is omitted', async () => {
    const filePath = writeFile('notes.txt');
    broker.queueResponse({
      body: { ok: true, upload_url: `${broker.origin}/upload-external`, file_id: 'F2' },
    });
    broker.queueResponse({ body: { ok: true, files: [{ id: 'F2' }] } });

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C123'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(0);
    expect(broker.requests[1].body.args.files).toEqual([{ id: 'F2', title: 'notes.txt' }]);
  });

  it('surfaces a structured error when the broker denies the completing channel', async () => {
    const filePath = writeFile('report.pdf');
    broker.queueResponse({
      body: { ok: true, upload_url: `${broker.origin}/upload-external`, file_id: 'F3' },
    });
    broker.queueResponse({
      status: 403,
      body: { error: 'Slack access grant does not allow this conversation' },
    });

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C999'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('access grant');
    expect(result.stderr).toContain('Error:');
    // The bytes were uploaded before the completing call failed, proving the
    // failure is the channel gate at step 3 rather than an earlier abort.
    expect(broker.uploads).toHaveLength(1);
  });

  it('exits 2 without contacting the broker when --file is missing', async () => {
    const result = await runCli(['upload', '--channel', 'C123'], proxyEnv());

    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message.toLowerCase()).toContain('file');
    expect(broker.requests).toHaveLength(0);
    expect(broker.uploads).toHaveLength(0);
  });

  it('exits 2 without contacting the broker when the file does not exist', async () => {
    const result = await runCli(
      ['upload', '--file', path.join(dir, 'missing.pdf'), '--channel', 'C123'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('missing.pdf');
    expect(broker.requests).toHaveLength(0);
    expect(broker.uploads).toHaveLength(0);
  });

  it('aborts before posting bytes when minting the upload URL fails', async () => {
    const filePath = writeFile('report.pdf');
    broker.queueResponse({ body: { ok: false, error: 'invalid_auth' } });

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C123'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    // The mint call returns ok:false at HTTP 200, so the error must be mapped
    // to the Slack code (and its suggestion) rather than a generic envelope.
    expect(output.error).toBe('invalid_auth');
    expect(output.suggestion).toBeTruthy();
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0].body.method).toBe('files.getUploadURLExternal');
    expect(broker.uploads).toHaveLength(0);
  });

  it('exits 1 when posting the file bytes to Slack fails', async () => {
    const filePath = writeFile('report.pdf');
    broker.queueResponse({
      body: { ok: true, upload_url: `${broker.origin}/upload-external`, file_id: 'F5' },
    });
    broker.queueUploadResponse({ status: 500 });

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C123'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('500');
    // The mint succeeded and the bytes were attempted, but the completing call
    // must never run once the byte POST fails.
    expect(broker.uploads).toHaveLength(1);
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0].body.method).toBe('files.getUploadURLExternal');
  });

  it('--dry-run reports the planned upload without contacting the broker', async () => {
    const filePath = writeFile('report.pdf');

    const result = await runCli(
      ['upload', '--file', filePath, '--channel', 'C123', '--dry-run'],
      proxyEnv(),
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dry_run).toBe(true);
    expect(output.transport).toBe('proxy');
    expect(output.length).toBe(fileBytes.length);
    expect(broker.requests).toHaveLength(0);
    expect(broker.uploads).toHaveLength(0);
  });
});
