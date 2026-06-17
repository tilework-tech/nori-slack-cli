// Direct-mode file download. Not a Slack Web API method: it resolves a file's
// authenticated URL via files.info and fetches the bytes with the bot token.
// The Slack-facing I/O (files.info, the HTTP GET) is injected so the logic is
// testable without a token or network.

export interface DownloadResult {
  ok: true;
  file: {
    id: string;
    name?: string;
    mimetype?: string;
    contentType?: string;
    contentBase64: string;
  };
}

export interface HttpDownload {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: Buffer;
}

export async function downloadFileDirect(
  fileId: string,
  filesInfo: (file: string) => Promise<Record<string, any>>,
  httpGet: (url: string) => Promise<HttpDownload>
): Promise<DownloadResult> {
  const info = await filesInfo(fileId);
  const file = info?.file;
  if (!file) {
    throw new Error(`files.info returned no file for '${fileId}'.`);
  }

  const url: string | undefined = file.url_private_download ?? file.url_private;
  if (!url) {
    throw new Error(
      `File '${fileId}' has no downloadable URL (url_private_download / url_private).`
    );
  }

  const download = await httpGet(url);
  if (!download.ok) {
    throw new Error(`Failed to download file '${fileId}': HTTP ${download.status}.`);
  }

  // A text/html 200 is Slack's sign-in page, not file bytes — the token is
  // missing the files:read scope or has no access to this file.
  if (download.contentType && download.contentType.includes('text/html')) {
    throw new Error(
      `Slack returned an HTML page instead of file bytes for '${fileId}'. The bot token likely lacks the files:read scope or access to this file.`
    );
  }

  const contentType = download.contentType ?? file.mimetype ?? undefined;
  return {
    ok: true,
    file: {
      id: file.id ?? fileId,
      name: file.name,
      mimetype: file.mimetype,
      contentType,
      contentBase64: download.bytes.toString('base64'),
    },
  };
}
