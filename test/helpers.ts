import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = path.resolve(__dirname, '../src/index.ts');
export const PROJECT_ROOT = path.resolve(__dirname, '..');

const SLACK_ENV_VARS = ['SLACK_BOT_TOKEN', 'NORI_SLACK_PROXY_URL', 'NORI_SLACK_CONTEXT_TOKEN'];

// Tests must not inherit Slack credentials from the host environment (Nori
// sessions export the proxy vars), so the CLI only sees what each test sets.
function hermeticEnv(env: Record<string, string>): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of SLACK_ENV_VARS) {
    delete base[key];
  }
  return { ...base, ...env };
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      'npx', ['tsx', CLI_PATH, ...args],
      {
        cwd: PROJECT_ROOT,
        env: hermeticEnv(env),
        timeout: 10000,
      }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.code ?? 1,
    };
  }
}

export async function runCliWithStdin(args: string[], stdinData: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: hermeticEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

export interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface RecordedUpload {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RecordedDownload {
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface FakeBroker {
  url: string;
  origin: string;
  requests: RecordedRequest[];
  uploads: RecordedUpload[];
  downloads: RecordedDownload[];
  queueResponse(response: { status?: number; body: unknown }): void;
  queueUploadResponse(response: { status?: number; body?: string }): void;
  queueDownloadResponse(response: { status?: number; body?: Buffer; contentType?: string }): void;
  close(): Promise<void>;
}

// A fake broker that doubles as Slack's external upload host. Requests to
// `/slack-proxy/method` are recorded as method calls and answered from the
// queued response list; any other path is treated as the byte-upload target
// (the URL `files.getUploadURLExternal` hands back), recorded raw, and answered
// with a plain 200 so it does not consume a queued method response.
export async function startFakeBroker(): Promise<FakeBroker> {
  const requests: RecordedRequest[] = [];
  const uploads: RecordedUpload[] = [];
  const downloads: RecordedDownload[] = [];
  const responses: Array<{ status?: number; body: unknown }> = [];
  const uploadResponses: Array<{ status?: number; body?: string }> = [];
  const downloadResponses: Array<{ status?: number; body?: Buffer; contentType?: string }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? '';
      const pathOnly = url.split('?')[0];
      if (req.method === 'GET' && pathOnly.endsWith('/download')) {
        downloads.push({ url, headers: req.headers });
        const next = downloadResponses.length > 0 ? downloadResponses.shift()! : { status: 200 };
        res.writeHead(next.status ?? 200, {
          'content-type': next.contentType ?? 'application/octet-stream',
        });
        res.end(next.body ?? Buffer.alloc(0));
        return;
      }
      if (!url.endsWith('/method')) {
        uploads.push({ url, headers: req.headers, body: raw });
        const next = uploadResponses.length > 0 ? uploadResponses.shift()! : { status: 200 };
        res.writeHead(next.status ?? 200, { 'content-type': 'text/plain' });
        res.end(next.body ?? `OK - ${raw.length}`);
        return;
      }
      requests.push({
        url,
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw.toString()) : null,
      });
      const next = responses.length > 0 ? responses.shift()! : { status: 200, body: { ok: true } };
      res.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/slack-proxy`,
    origin,
    requests,
    uploads,
    downloads,
    queueResponse(response) {
      responses.push(response);
    },
    queueUploadResponse(response) {
      uploadResponses.push(response);
    },
    queueDownloadResponse(response) {
      downloadResponses.push(response);
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
