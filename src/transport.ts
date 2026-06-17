import { WebClient } from '@slack/web-api';
import { downloadFileDirect, type HttpDownload } from './download.js';

export type TransportMode = 'proxy' | 'direct' | 'none';

export interface Transport {
  mode: 'proxy' | 'direct';
  call(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
  download(fileId: string): Promise<Record<string, any>>;
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
    const call = async (method: string, params: Record<string, unknown>) => {
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
    };
    return {
      mode,
      call,
      // The broker fetches the bytes on the session's behalf, since a scoped
      // session never holds the raw bot token needed for url_private.
      download(fileId) {
        return call('files.download', { file: fileId });
      },
    };
  }

  if (mode === 'direct') {
    const token = env.SLACK_BOT_TOKEN!;
    const client = new WebClient(token);
    return {
      mode,
      call(method, params) {
        return client.apiCall(method, params) as Promise<Record<string, any>>;
      },
      download(fileId) {
        return downloadFileDirect(
          fileId,
          (file) => client.apiCall('files.info', { file }) as Promise<Record<string, any>>,
          async (url): Promise<HttpDownload> => {
            const res = await fetch(url, {
              headers: { authorization: `Bearer ${token}` },
            });
            const bytes = Buffer.from(await res.arrayBuffer());
            return {
              ok: res.ok,
              status: res.status,
              contentType: res.headers.get('content-type'),
              bytes,
            };
          }
        );
      },
    };
  }

  return null;
}
