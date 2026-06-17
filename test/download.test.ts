import { describe, it, expect } from 'vitest';
import { downloadFileDirect, type HttpDownload } from '../src/download.js';

function okInfo(file: Record<string, any>) {
  return async () => ({ ok: true, file });
}

describe('downloadFileDirect', () => {
  it('fetches url_private_download and returns base64 bytes', async () => {
    const bytes = Buffer.from('hello-bytes\x00\x01\x02', 'binary');
    let fetchedUrl = '';
    const result = await downloadFileDirect(
      'F1',
      okInfo({
        id: 'F1',
        name: 'a.png',
        mimetype: 'image/png',
        url_private_download: 'https://files.slack.com/F1/download',
      }),
      async (url): Promise<HttpDownload> => {
        fetchedUrl = url;
        return { ok: true, status: 200, contentType: 'image/png', bytes };
      }
    );

    expect(fetchedUrl).toBe('https://files.slack.com/F1/download');
    expect(result.ok).toBe(true);
    expect(result.file.id).toBe('F1');
    expect(result.file.name).toBe('a.png');
    expect(result.file.contentType).toBe('image/png');
    expect(result.file.contentBase64).toBe(bytes.toString('base64'));
  });

  it('falls back to url_private when url_private_download is absent', async () => {
    let fetchedUrl = '';
    await downloadFileDirect(
      'F2',
      okInfo({ id: 'F2', url_private: 'https://files.slack.com/F2/priv' }),
      async (url): Promise<HttpDownload> => {
        fetchedUrl = url;
        return { ok: true, status: 200, contentType: 'application/pdf', bytes: Buffer.from('x') };
      }
    );

    expect(fetchedUrl).toBe('https://files.slack.com/F2/priv');
  });

  it('falls back to file.mimetype when the response has no content-type', async () => {
    const result = await downloadFileDirect(
      'F3',
      okInfo({ id: 'F3', mimetype: 'image/gif', url_private_download: 'u' }),
      async (): Promise<HttpDownload> => ({
        ok: true,
        status: 200,
        contentType: null,
        bytes: Buffer.from('x'),
      })
    );

    expect(result.file.contentType).toBe('image/gif');
  });

  it('throws when the file has no downloadable URL', async () => {
    await expect(
      downloadFileDirect('F4', okInfo({ id: 'F4' }), async () => {
        throw new Error('should not fetch');
      })
    ).rejects.toThrow(/no downloadable URL/i);
  });

  it('throws on a non-ok HTTP status', async () => {
    await expect(
      downloadFileDirect(
        'F5',
        okInfo({ id: 'F5', url_private_download: 'u' }),
        async (): Promise<HttpDownload> => ({
          ok: false,
          status: 403,
          contentType: null,
          bytes: Buffer.alloc(0),
        })
      )
    ).rejects.toThrow(/HTTP 403/);
  });

  it('throws when Slack returns an HTML sign-in page instead of bytes', async () => {
    await expect(
      downloadFileDirect(
        'F6',
        okInfo({ id: 'F6', url_private_download: 'u' }),
        async (): Promise<HttpDownload> => ({
          ok: true,
          status: 200,
          contentType: 'text/html; charset=utf-8',
          bytes: Buffer.from('<html>signin</html>'),
        })
      )
    ).rejects.toThrow(/HTML page/i);
  });
});
