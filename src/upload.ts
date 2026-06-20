import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Transport } from './transport.js';

export interface UploadArgs {
  transport: Transport;
  filePath: string;
  channel?: string | null;
  title?: string | null;
  filename?: string | null;
  initialComment?: string | null;
  threadTs?: string | null;
  altText?: string | null;
  snippetType?: string | null;
}

// Drives Slack's modern external upload (the flow Bolt exposes as
// files.uploadV2, which the dynamic apiCall path cannot reach): mint an upload
// URL, POST the raw bytes straight to it, then complete the upload through the
// transport so proxy-mode channel scoping is enforced at the completing call.
export async function uploadFile(args: UploadArgs): Promise<Record<string, any>> {
  const { transport, filePath } = args;
  const bytes = await readFile(filePath);
  const filename = args.filename ?? path.basename(filePath);

  const getUrlParams: Record<string, unknown> = { filename, length: bytes.length };
  if (args.altText != null) getUrlParams.alt_text = args.altText;
  if (args.snippetType != null) getUrlParams.snippet_type = args.snippetType;
  const minted = await transport.call('files.getUploadURLExternal', getUrlParams);

  // Proxy mode returns Slack's ok:false body at HTTP 200 without throwing
  // (only non-2xx throws), so surface it as the platform-error shape direct
  // mode already throws, letting formatError map the Slack code to a suggestion.
  if (minted.ok === false) {
    throw Object.assign(new Error(`Slack API error: ${minted.error ?? 'unknown_error'}`), {
      code: 'slack_webapi_platform_error',
      data: { error: minted.error },
    });
  }

  const uploadUrl = minted.upload_url;
  const fileId = minted.file_id;
  if (typeof uploadUrl !== 'string' || typeof fileId !== 'string') {
    throw new Error(
      `files.getUploadURLExternal did not return an upload URL: ${JSON.stringify(minted)}`,
    );
  }

  // The upload URL is itself the credential, so the bytes go directly to Slack's
  // upload host with no token and without touching the broker proxy.
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!uploadRes.ok) {
    throw new Error(`Uploading file bytes to Slack failed (HTTP ${uploadRes.status})`);
  }

  const completeParams: Record<string, unknown> = {
    files: [{ id: fileId, title: args.title ?? filename }],
  };
  if (args.channel != null) completeParams.channel_id = args.channel;
  if (args.initialComment != null) completeParams.initial_comment = args.initialComment;
  if (args.threadTs != null) completeParams.thread_ts = args.threadTs;

  return await transport.call('files.completeUploadExternal', completeParams);
}
