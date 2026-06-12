import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, runCliWithStdin, startFakeBroker, type FakeBroker } from './helpers.js';

describe('proxy mode', () => {
  let broker: FakeBroker;

  beforeEach(async () => {
    broker = await startFakeBroker();
  });

  afterEach(async () => {
    await broker.close();
  });

  function proxyEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NORI_SLACK_PROXY_URL: broker.url,
      NORI_SLACK_CONTEXT_TOKEN: 'ctx-token-123',
      ...extra,
    };
  }

  it('sends {method, args} to <proxy>/method with a bearer token and prints the response', async () => {
    broker.queueResponse({ body: { ok: true, ts: '1716000000.000100' } });
    const result = await runCli(
      ['chat.postMessage', '--channel', 'C123', '--text', 'hello'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.ts).toBe('1716000000.000100');
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0].url).toBe('/slack-proxy/method');
    expect(broker.requests[0].headers.authorization).toBe('Bearer ctx-token-123');
    expect(broker.requests[0].body).toEqual({
      method: 'chat.postMessage',
      args: { channel: 'C123', text: 'hello' },
    });
  });

  it('prefers the proxy when both proxy vars and SLACK_BOT_TOKEN are set', async () => {
    const result = await runCli(
      ['chat.postMessage', '--channel', 'C123', '--text', 'hi'],
      proxyEnv({ SLACK_BOT_TOKEN: 'xoxb-fake-token' })
    );
    expect(result.exitCode).toBe(0);
    expect(broker.requests).toHaveLength(1);
  });

  it('handles a trailing slash in the proxy URL', async () => {
    const result = await runCli(
      ['chat.postMessage', '--channel', 'C123', '--text', 'hi'],
      proxyEnv({ NORI_SLACK_PROXY_URL: broker.url + '/' })
    );
    expect(result.exitCode).toBe(0);
    expect(broker.requests[0].url).toBe('/slack-proxy/method');
  });

  it('--json-input params reach the broker intact', async () => {
    const params = {
      channel: 'C123',
      text: '*markdown* with `code`',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }],
    };
    const result = await runCliWithStdin(
      ['chat.postMessage', '--json-input'],
      JSON.stringify(params),
      proxyEnv()
    );
    expect(result.exitCode).toBe(0);
    expect(broker.requests[0].body).toEqual({
      method: 'chat.postMessage',
      args: params,
    });
  });

  it('converts kebab-case flags and coerces values in proxy mode', async () => {
    const result = await runCli(
      ['conversations.replies', '--channel', 'C123', '--thread-ts', '1716000000.001200', '--limit', '10'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(0);
    expect(broker.requests[0].body.args).toEqual({
      channel: 'C123',
      thread_ts: '1716000000.001200',
      limit: 10,
    });
  });

  it('maps broker errors to the structured error envelope', async () => {
    broker.queueResponse({
      status: 403,
      body: { error: 'Slack method is not available through scoped proxy' },
    });
    const result = await runCli(
      ['search.messages', '--query', 'foo'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.message).toContain('Slack method is not available through scoped proxy');
    expect(output.suggestion.length).toBeGreaterThan(0);
    expect(result.stderr).toContain('Error:');
  });

  it('extracts slack error codes from proxied platform errors', async () => {
    broker.queueResponse({
      status: 403,
      body: { error: 'An API error occurred: channel_not_found' },
    });
    const result = await runCli(
      ['chat.postMessage', '--channel', 'C404', '--text', 'hi'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.error).toBe('channel_not_found');
    expect(output.suggestion).toContain('conversations.list');
  });

  it('maps a 401 from the broker to a context-token suggestion', async () => {
    broker.queueResponse({ status: 401, body: { error: 'Unauthorized' } });
    const result = await runCli(
      ['chat.postMessage', '--channel', 'C123', '--text', 'hi'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.suggestion).toContain('NORI_SLACK_CONTEXT_TOKEN');
  });

  it('--paginate merges cursor pages through the proxy', async () => {
    broker.queueResponse({
      body: {
        ok: true,
        channels: [{ id: 'C1' }, { id: 'C2' }],
        response_metadata: { next_cursor: 'cursor-abc' },
      },
    });
    broker.queueResponse({
      body: {
        ok: true,
        channels: [{ id: 'C3' }],
        response_metadata: { next_cursor: '' },
      },
    });
    const result = await runCli(['conversations.list', '--paginate'], proxyEnv());
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.channels.map((c: any) => c.id)).toEqual(['C1', 'C2', 'C3']);
    expect(broker.requests).toHaveLength(2);
    expect(broker.requests[1].body.args.cursor).toBe('cursor-abc');
  });

  it('--dry-run reports the proxy transport without contacting the broker', async () => {
    const result = await runCli(
      ['chat.postMessage', '--dry-run', '--channel', 'C123'],
      proxyEnv()
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.dry_run).toBe(true);
    expect(output.transport).toBe('proxy');
    expect(broker.requests).toHaveLength(0);
  });

  it('--dry-run reports the direct transport with only a bot token', async () => {
    const result = await runCli(
      ['chat.postMessage', '--dry-run', '--channel', 'C123'],
      { SLACK_BOT_TOKEN: 'xoxb-test-token' }
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.transport).toBe('direct');
  });

  it('--dry-run reports no transport when no credentials are set', async () => {
    const result = await runCli(
      ['chat.postMessage', '--dry-run', '--channel', 'C123'],
      {}
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.transport).toBe('none');
  });

  it('no-credentials error mentions both auth options', async () => {
    const result = await runCli(['chat.postMessage', '--channel', 'C123'], {});
    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.error).toBe('no_token');
    expect(output.suggestion).toContain('SLACK_BOT_TOKEN');
    expect(output.suggestion).toContain('NORI_SLACK_PROXY_URL');
  });
});
