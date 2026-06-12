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

export interface FakeBroker {
  url: string;
  requests: RecordedRequest[];
  queueResponse(response: { status?: number; body: unknown }): void;
  close(): Promise<void>;
}

export async function startFakeBroker(): Promise<FakeBroker> {
  const requests: RecordedRequest[] = [];
  const responses: Array<{ status?: number; body: unknown }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      requests.push({
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      const next = responses.length > 0 ? responses.shift()! : { status: 200, body: { ok: true } };
      res.writeHead(next.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/slack-proxy`,
    requests,
    queueResponse(response) {
      responses.push(response);
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
