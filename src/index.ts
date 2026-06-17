#!/usr/bin/env node

import { Command } from 'commander';
import { parseArgs } from './parse-args.js';
import { formatError } from './errors.js';
import { KNOWN_METHODS, PROXY_METHODS, isKnownMethod } from './methods.js';
import { mergePages, paginatePages } from './paginate.js';
import { detectTransportMode, resolveTransport } from './transport.js';
import { getMethodMetadata, METHOD_METADATA } from './method-metadata.js';
import { findSimilarMethods } from './suggest.js';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');

const program = new Command();

program
  .name('nori-slack')
  .description('CLI for the Slack Web API. Designed for coding agents.\n\nUsage: nori-slack <method> [--param value ...]\n\nExamples:\n  nori-slack chat.postMessage --channel C123 --text "Hello"\n  nori-slack conversations.list --limit 10\n  nori-slack api.test --foo bar\n  echo \'{"channel":"C123","text":"hi"}\' | nori-slack chat.postMessage --json-input')
  .version('0.2.0');

program
  .command('list-methods')
  .description('List all known Slack Web API methods. Use --namespace to filter by API namespace (e.g., chat, conversations). Use --descriptions to include method descriptions.')
  .option('--namespace <ns>', 'Filter methods by namespace prefix (e.g., "chat", "conversations", "files")')
  .option('--descriptions', 'Include a short description for each method')
  .action((opts: { namespace?: string; descriptions?: boolean }) => {
    let methods = [...KNOWN_METHODS, ...PROXY_METHODS];

    if (opts.namespace) {
      const prefix = opts.namespace + '.';
      methods = methods.filter(m => m.startsWith(prefix));
    }

    const result: Record<string, unknown> = {};

    if (opts.descriptions) {
      result.methods = methods.map(m => ({
        method: m,
        description: getMethodMetadata(m).description,
      }));
    } else {
      result.methods = methods;
    }

    if (opts.namespace) {
      result.namespace = opts.namespace;
    }

    process.stdout.write(JSON.stringify(result) + '\n');
  });

program
  .command('describe <method>')
  .description('Show parameter documentation for a Slack API method. Example: nori-slack describe chat.postMessage')
  .action((method: string) => {
    const meta = getMethodMetadata(method);
    const result: Record<string, unknown> = {
      ok: true,
      method,
      known: method in METHOD_METADATA,
      ...meta,
    };
    if (!(method in METHOD_METADATA)) {
      const suggestions = findSimilarMethods(method);
      if (suggestions.length > 0) {
        result.suggestions = suggestions;
      }
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  });

program
  .argument('<method>', 'Slack Web API method (e.g., chat.postMessage)')
  .option('--json-input', 'Read parameters as JSON from stdin')
  .option('--paginate', 'Automatically fetch all pages and merge results')
  .option('--dry-run', 'Preview the API request without sending it. Shows method, resolved params, and token status.')
  .option('--output <path>', 'For files.download: decode the returned bytes and write them to this path instead of printing base64.')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (method: string, opts: Record<string, any>) => {
    let params: Record<string, unknown> = {};

    if (opts.jsonInput) {
      if (process.stdin.isTTY) {
        const error = formatError(
          new Error('--json-input requires piped input. Example: echo \'{"channel":"C123"}\' | nori-slack chat.postMessage --json-input'),
          SOURCE_DIR
        );
        process.stdout.write(JSON.stringify(error) + '\n');
        process.exit(2);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const stdinData = Buffer.concat(chunks).toString().trim();
      if (stdinData) {
        try {
          params = JSON.parse(stdinData);
        } catch {
          const error = formatError(
            new Error(`Invalid JSON on stdin: ${stdinData.slice(0, 100)}`),
            SOURCE_DIR
          );
          process.stdout.write(JSON.stringify(error) + '\n');
          process.exit(2);
        }
      }
    }

    // Parse CLI args directly from process.argv, skipping node, script, method,
    // and the CLI's own flags so they don't leak into the Slack API params.
    const BOOLEAN_CLI_OPTIONS = ['--json-input', '--paginate', '--dry-run'];
    const VALUE_CLI_OPTIONS = ['--output'];
    const methodIndex = process.argv.indexOf(method);
    const rawSlice = methodIndex >= 0 ? process.argv.slice(methodIndex + 1) : [];
    const rawArgs: string[] = [];
    for (let i = 0; i < rawSlice.length; i++) {
      const arg = rawSlice[i];
      if (BOOLEAN_CLI_OPTIONS.includes(arg)) continue;
      if (VALUE_CLI_OPTIONS.includes(arg)) {
        i++; // also skip this option's value
        continue;
      }
      if (VALUE_CLI_OPTIONS.some(opt => arg.startsWith(opt + '='))) continue;
      rawArgs.push(arg);
    }
    const cliParams = parseArgs(rawArgs);
    params = { ...params, ...cliParams };

    if (opts.dryRun) {
      const dryRunResult: Record<string, unknown> = {
        ok: true,
        dry_run: true,
        method,
        params,
        transport: detectTransportMode(),
        token_present: !!process.env.SLACK_BOT_TOKEN,
        paginate: !!opts.paginate,
      };
      if (!isKnownMethod(method)) {
        const suggestions = findSimilarMethods(method);
        const didYouMean = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
        dryRunResult.warning = `Method '${method}' is not in the known methods list.${didYouMean} It may still be valid.`;
        if (suggestions.length > 0) {
          dryRunResult.suggestions = suggestions;
        }
      }
      process.stdout.write(JSON.stringify(dryRunResult) + '\n');
      return;
    }

    const transport = resolveTransport();
    if (!transport) {
      const error = formatError({ code: 'no_token' }, SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.exit(1);
    }

    if (PROXY_METHODS.includes(method) && transport.mode === 'direct') {
      const error = formatError({ code: 'proxy_only_method', method }, SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.stderr.write(`Error: ${error.message}\nSuggestion: ${error.suggestion}\n`);
      process.exit(1);
    }

    if (!isKnownMethod(method)) {
      const suggestions = findSimilarMethods(method);
      if (suggestions.length > 0) {
        process.stderr.write(`Warning: Method '${method}' is not in the known methods list. Did you mean: ${suggestions.join(', ')}?\n`);
      }
    }

    try {
      let result;
      if (opts.paginate) {
        result = await mergePages(paginatePages(transport, method, params));
      } else {
        result = await transport.call(method, params);
      }

      if (method === 'files.download' && opts.output && typeof result?.file?.contentBase64 === 'string') {
        const file = result.file;
        const outPath = path.resolve(process.cwd(), opts.output);
        const bytes = Buffer.from(file.contentBase64, 'base64');
        writeFileSync(outPath, bytes);
        result = {
          ok: result.ok ?? true,
          file: {
            id: file.id,
            name: file.name,
            mimetype: file.mimetype,
            contentType: file.contentType,
            bytes: bytes.length,
            path: outPath,
          },
        };
      }

      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err) {
      const error = formatError(err, SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.stderr.write(`Error: ${error.message}\nSuggestion: ${error.suggestion}\n`);
      process.exit(1);
    }
  });

// Show help on stderr when no args provided
if (process.argv.length <= 2) {
  process.stderr.write(program.helpInformation() + '\n');
  process.stderr.write('Error: missing required method argument\n');
  process.stderr.write(`Source: ${SOURCE_DIR}\n`);
  process.exit(2);
}

program.parse();
