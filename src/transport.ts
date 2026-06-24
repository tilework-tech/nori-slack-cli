import { WebClient } from '@slack/web-api';

export type TransportMode = 'proxy' | 'direct' | 'none';

export interface DownloadResult {
  bytes: Buffer;
  contentType: string | null;
  filename: string | null;
}

export interface Transport {
  mode: 'proxy' | 'direct';
  call(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  downloadFile(args: { fileId: string }): Promise<DownloadResult>;
}

export const PROXY_ERROR_CODE = 'nori_slack_proxy_error';

export class ProxyError extends Error {
  code = PROXY_ERROR_CODE;
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function detectTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  if (env.NORI_SLACK_PROXY_URL && env.NORI_SLACK_CONTEXT_TOKEN) return 'proxy';
  if (env.SLACK_BOT_TOKEN) return 'direct';
  return 'none';
}

export function resolveTransport(env: NodeJS.ProcessEnv = process.env): Transport | null {
  const mode = detectTransportMode(env);

  if (mode === 'proxy') {
    const baseUrl = env.NORI_SLACK_PROXY_URL!.replace(/\/+$/, '');
    const contextToken = env.NORI_SLACK_CONTEXT_TOKEN!;
    return {
      mode,
      async call(method, params) {
        const res = await fetch(`${baseUrl}/method`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${contextToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ method, args: params }),
        });
        const text = await res.text();
        let body: any = null;
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON body: fall through with the raw text as the error message.
        }
        if (!res.ok) {
          throw new ProxyError(res.status, typeof body?.error === 'string' ? body.error : text);
        }
        return body;
      },
      async downloadFile({ fileId }) {
        const res = await fetch(`${baseUrl}/download?file=${encodeURIComponent(fileId)}`, {
          headers: { authorization: `Bearer ${contextToken}` },
        });
        if (!res.ok) {
          const text = await res.text();
          let body: any = null;
          try {
            body = JSON.parse(text);
          } catch {
            // Non-JSON body: fall through with the raw text as the error message.
          }
          throw new ProxyError(res.status, typeof body?.error === 'string' ? body.error : text);
        }
        return {
          bytes: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get('content-type'),
          filename: null,
        };
      },
    };
  }

  if (mode === 'direct') {
    const botToken = env.SLACK_BOT_TOKEN!;
    const client = new WebClient(botToken);
    return {
      mode,
      call(method, params) {
        return client.apiCall(method, params) as Promise<Record<string, any>>;
      },
      async downloadFile({ fileId }) {
        const info = await this.call('files.info', { file: fileId });
        const file = info.file as { url_private_download?: string; name?: string } | undefined;
        const url = file?.url_private_download;
        if (!url) {
          throw new Error(`files.info did not return a download URL for file ${fileId}`);
        }
        const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
        if (!res.ok) {
          throw new Error(`Failed to download file ${fileId}: HTTP ${res.status}`);
        }
        const contentType = res.headers.get('content-type');
        // Slack's file host answers an unauthenticated request with HTTP 200 and
        // an HTML sign-in page rather than an error status, so a rejected bot
        // token would otherwise be written to disk as a "successful" download.
        if (contentType != null && contentType.includes('text/html')) {
          throw new Error(
            `Slack returned an HTML page instead of file ${fileId}; the bot token was not authenticated for this file`,
          );
        }
        return {
          bytes: Buffer.from(await res.arrayBuffer()),
          contentType,
          filename: file?.name ?? null,
        };
      },
    };
  }

  return null;
}
