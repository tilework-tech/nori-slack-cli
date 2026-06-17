export interface CliError {
  ok: false;
  error: string;
  message: string;
  suggestion: string;
  source: string;
}

const SUGGESTIONS: Record<string, string> = {
  channel_not_found: 'Check the channel ID. Use `nori-slack conversations.list` to find valid channels.',
  not_in_channel: 'The bot is not in this channel. Use `nori-slack conversations.join --channel <id>` first.',
  invalid_auth: 'The bot token is invalid. Check that SLACK_BOT_TOKEN is set to a valid xoxb-* token.',
  missing_scope: 'The bot token lacks a required scope. Check your Slack app permissions at https://api.slack.com/apps.',
  no_token: 'Set the SLACK_BOT_TOKEN environment variable (direct mode, xoxb-* token), or NORI_SLACK_PROXY_URL + NORI_SLACK_CONTEXT_TOKEN (session proxy mode).',
  account_inactive: 'The token belongs to a deactivated account. Generate a new token.',
  token_revoked: 'The bot token has been revoked. Generate a new token from your Slack app settings.',
  channel_not_found_or_not_accessible: 'The channel does not exist or the bot cannot access it. Use `nori-slack conversations.list` to check.',
  not_authed: 'No authentication token provided. Set SLACK_BOT_TOKEN environment variable.',
  too_many_attachments: 'Message has too many attachments. Slack limits to 100 attachments per message.',
  msg_too_long: 'Message text exceeds 40,000 characters. Split into multiple messages.',
  no_text: 'Message must include text, blocks, or attachments. Provide at least one.',
  rate_limited: 'Rate limited by Slack. Wait and retry.',
};

export function formatError(error: unknown, sourceDir: string): CliError {
  const err = error as Record<string, any>;

  if (err?.code === 'no_token') {
    return {
      ok: false,
      error: 'no_token',
      message: 'No Slack credentials provided.',
      suggestion: SUGGESTIONS.no_token,
      source: sourceDir,
    };
  }

  if (err?.code === 'proxy_only_method') {
    const method = err.method ? `'${err.method}'` : 'This method';
    return {
      ok: false,
      error: 'proxy_only_method',
      message: `${method} is only available through the Nori Sessions Slack proxy, not direct mode.`,
      suggestion: 'It is implemented by the session broker, not the Slack Web API. Run inside a Nori Session with NORI_SLACK_PROXY_URL + NORI_SLACK_CONTEXT_TOKEN set, instead of SLACK_BOT_TOKEN.',
      source: sourceDir,
    };
  }

  if (err?.code === 'nori_slack_proxy_error') {
    const status: number = err.status;
    const brokerMessage: string = err.message || 'Unknown proxy error';

    // The broker surfaces Slack platform errors as "An API error occurred: <code>".
    const platformMatch = /An API error occurred: ([a-z0-9_]+)/.exec(brokerMessage);
    if (platformMatch) {
      const slackError = platformMatch[1];
      return {
        ok: false,
        error: slackError,
        message: `Slack API error: ${slackError}`,
        suggestion: SUGGESTIONS[slackError] || `Refer to Slack API docs for error "${slackError}". Run \`nori-slack list-methods\` for available methods.`,
        source: sourceDir,
      };
    }

    if (status === 401) {
      return {
        ok: false,
        error: 'proxy_unauthorized',
        message: `Slack proxy rejected the request (HTTP 401): ${brokerMessage}`,
        suggestion: 'The session proxy rejected the context token. Check that NORI_SLACK_CONTEXT_TOKEN is current; it may have been rotated.',
        source: sourceDir,
      };
    }

    return {
      ok: false,
      error: 'proxy_error',
      message: `Slack proxy error (HTTP ${status}): ${brokerMessage}`,
      suggestion: "This session's Slack access grant does not permit the request. Stay within the session's conversation, or use direct mode with SLACK_BOT_TOKEN.",
      source: sourceDir,
    };
  }

  if (err?.code === 'slack_webapi_platform_error') {
    const slackError = err.data?.error || 'unknown_platform_error';
    return {
      ok: false,
      error: slackError,
      message: `Slack API error: ${slackError}`,
      suggestion: SUGGESTIONS[slackError] || `Refer to Slack API docs for error "${slackError}". Run \`nori-slack list-methods\` for available methods.`,
      source: sourceDir,
    };
  }

  if (err?.code === 'slack_webapi_rate_limited_error') {
    const retryAfter = err.retryAfter || 'unknown';
    return {
      ok: false,
      error: 'rate_limited',
      message: `Rate limited. Retry after ${retryAfter} seconds.`,
      suggestion: SUGGESTIONS.rate_limited,
      source: sourceDir,
    };
  }

  if (err?.code === 'slack_webapi_request_error') {
    const originalMsg = err.original?.message || 'Unknown network error';
    return {
      ok: false,
      error: 'request_error',
      message: `Network error: ${originalMsg}`,
      suggestion: 'Check your network connection and try again.',
      source: sourceDir,
    };
  }

  // Generic fallback
  const message = err?.message || String(error);
  return {
    ok: false,
    error: 'unknown_error',
    message,
    suggestion: `Unexpected error. Check the CLI source at ${sourceDir} for details.`,
    source: sourceDir,
  };
}
