import { WebClient } from '@slack/web-api';

export type TransportMode = 'proxy' | 'direct' | 'none';

export interface Transport {
  mode: 'proxy' | 'direct';
  call(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
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
    };
  }

  if (mode === 'direct') {
    const client = new WebClient(env.SLACK_BOT_TOKEN);
    return {
      mode,
      call(method, params) {
        return client.apiCall(method, params) as Promise<Record<string, any>>;
      },
    };
  }

  return null;
}
