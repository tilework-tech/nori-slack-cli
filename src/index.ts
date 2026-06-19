#!/usr/bin/env node

import { Command } from 'commander';
import { parseArgs } from './parse-args.js';
import { formatError } from './errors.js';
import { KNOWN_METHODS } from './methods.js';
import { mergePages, paginatePages } from './paginate.js';
import { detectTransportMode, resolveTransport } from './transport.js';
import { getMethodMetadata, METHOD_METADATA } from './method-metadata.js';
import { findSimilarMethods } from './suggest.js';
import { uploadFile } from './upload.js';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(__dirname, '..');

const program = new Command();

// The default command (program.argument('<method>')) declares --dry-run, so
// without positional options Commander parses that program-level flag instead
// of the upload subcommand's identically-named flag. Positional options scope
// each command's options to the tokens that follow its own name.
program.enablePositionalOptions();

program
  .name('nori-slack')
  .description('CLI for the Slack Web API. Designed for coding agents.\n\nUsage: nori-slack <method> [--param value ...]\n\nExamples:\n  nori-slack chat.postMessage --channel C123 --text "Hello"\n  nori-slack conversations.list --limit 10\n  nori-slack api.test --foo bar\n  echo \'{"channel":"C123","text":"hi"}\' | nori-slack chat.postMessage --json-input')
  .version('0.3.0');

program
  .command('list-methods')
  .description('List all known Slack Web API methods. Use --namespace to filter by API namespace (e.g., chat, conversations). Use --descriptions to include method descriptions.')
  .option('--namespace <ns>', 'Filter methods by namespace prefix (e.g., "chat", "conversations", "files")')
  .option('--descriptions', 'Include a short description for each method')
  .action((opts: { namespace?: string; descriptions?: boolean }) => {
    let methods = KNOWN_METHODS;

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
  .command('upload')
  .description('Upload a local file to Slack and share it into a channel using the modern external upload flow (Bolt\'s files.uploadV2). Example: nori-slack upload --file ./report.pdf --channel C123')
  .option('--file <path>', 'Path to the local file to upload')
  .option('--channel <id>', 'Channel ID to share the file into')
  .option('--title <title>', 'Title for the file (defaults to the filename)')
  .option('--filename <name>', 'Filename to register with Slack (defaults to the basename of --file)')
  .option('--initial-comment <text>', 'Message text to post alongside the file')
  .option('--thread-ts <ts>', 'Thread timestamp to share the file into')
  .option('--alt-text <text>', 'Alt text for the file')
  .option('--snippet-type <type>', 'Snippet type for text snippets')
  .option('--dry-run', 'Preview the planned upload without contacting Slack')
  .action(async (opts: {
    file?: string;
    channel?: string;
    title?: string;
    filename?: string;
    initialComment?: string;
    threadTs?: string;
    altText?: string;
    snippetType?: string;
    dryRun?: boolean;
  }) => {
    const filePath = opts.file;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      const error = formatError(
        new Error('upload requires --file <path>. Example: nori-slack upload --file ./report.pdf --channel C123'),
        SOURCE_DIR
      );
      process.stdout.write(JSON.stringify(error) + '\n');
      process.exit(2);
    }

    let length: number;
    try {
      length = statSync(filePath).size;
    } catch {
      const error = formatError(new Error(`Cannot read file: ${filePath}`), SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.exit(2);
    }

    const filename = opts.filename ?? path.basename(filePath);

    if (opts.dryRun) {
      const dryRunResult = {
        ok: true,
        dry_run: true,
        command: 'upload',
        file: filePath,
        filename,
        length,
        channel: opts.channel ?? null,
        title: opts.title ?? filename,
        transport: detectTransportMode(),
        token_present: !!process.env.SLACK_BOT_TOKEN,
      };
      process.stdout.write(JSON.stringify(dryRunResult) + '\n');
      return;
    }

    const transport = resolveTransport();
    if (!transport) {
      const error = formatError({ code: 'no_token' }, SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.exit(1);
    }

    try {
      const result = await uploadFile({
        transport,
        filePath,
        channel: opts.channel ?? null,
        title: opts.title ?? null,
        filename: opts.filename ?? null,
        initialComment: opts.initialComment ?? null,
        threadTs: opts.threadTs ?? null,
        altText: opts.altText ?? null,
        snippetType: opts.snippetType ?? null,
      });
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err) {
      const error = formatError(err, SOURCE_DIR);
      process.stdout.write(JSON.stringify(error) + '\n');
      process.stderr.write(`Error: ${error.message}\nSuggestion: ${error.suggestion}\n`);
      process.exit(1);
    }
  });

program
  .argument('<method>', 'Slack Web API method (e.g., chat.postMessage)')
  .option('--json-input', 'Read parameters as JSON from stdin')
  .option('--paginate', 'Automatically fetch all pages and merge results')
  .option('--dry-run', 'Preview the API request without sending it. Shows method, resolved params, and token status.')
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

    // Parse CLI args directly from process.argv, skipping node, script, and method
    const CLI_OPTIONS = ['--json-input', '--paginate', '--dry-run'];
    const methodIndex = process.argv.indexOf(method);
    const rawArgs = methodIndex >= 0 ? process.argv.slice(methodIndex + 1).filter(a => !CLI_OPTIONS.includes(a)) : [];
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
      if (!KNOWN_METHODS.includes(method)) {
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

    if (!KNOWN_METHODS.includes(method)) {
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
