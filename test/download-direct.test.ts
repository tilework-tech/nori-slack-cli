import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveTransport } from '../src/transport.js';

// Direct mode cannot make real Slack calls in tests, so the files.info metadata
// lookup (the Slack boundary) is stubbed by overriding the transport's own
// `call`, while the byte fetch runs for real against a local host. This proves
// the security-relevant behavior: the private download is fetched with the bot
// token as a Bearer credential and the exact bytes are returned uncorrupted.
describe('download (direct mode)', () => {
  let fileHost: http.Server;
  let fileUrl: string;
  let received: { authorization?: string } = {};
  let respond: (res: http.ServerResponse) => void;

  const fileBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xc3, 0xa9, 0x00, 0xff]);

  beforeEach(async () => {
    received = {};
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(fileBytes);
    };
    fileHost = http.createServer((req, res) => {
      received.authorization = req.headers.authorization;
      respond(res);
    });
    await new Promise<void>((resolve) => fileHost.listen(0, '127.0.0.1', resolve));
    const port = (fileHost.address() as AddressInfo).port;
    fileUrl = `http://127.0.0.1:${port}/private/F123`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fileHost.close(() => resolve()));
  });

  const directTransport = () => {
    const transport = resolveTransport({ SLACK_BOT_TOKEN: 'xoxb-test-token' } as NodeJS.ProcessEnv);
    expect(transport?.mode).toBe('direct');
    transport!.call = async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe('files.info');
      expect(params).toEqual({ file: 'F123' });
      return {
        ok: true,
        file: { id: 'F123', name: 'doc.pdf', mimetype: 'application/pdf', url_private_download: fileUrl },
      };
    };
    return transport!;
  };

  it('fetches the private download URL with the bot token and returns the exact bytes', async () => {
    const transport = directTransport();

    const result = await transport.downloadFile({ fileId: 'F123' });

    expect(received.authorization).toBe('Bearer xoxb-test-token');
    expect(result.bytes.equals(fileBytes)).toBe(true);
    expect(result.contentType).toBe('application/pdf');
  });

  it('rejects the HTML login page Slack serves with HTTP 200 when the bot token is rejected', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>You are not signed in</body></html>');
    };
    const transport = directTransport();

    await expect(transport.downloadFile({ fileId: 'F123' })).rejects.toThrow(/not authenticated|html|sign/i);
  });
});
