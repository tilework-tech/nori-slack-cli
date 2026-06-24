import { writeFile } from 'node:fs/promises';
import type { Transport } from './transport.js';

export interface DownloadArgs {
  transport: Transport;
  fileId: string;
  outputPath: string;
}

export async function downloadFile(args: DownloadArgs): Promise<Record<string, any>> {
  const { transport, fileId, outputPath } = args;
  const { bytes, contentType, filename } = await transport.downloadFile({ fileId });
  await writeFile(outputPath, bytes);
  return {
    ok: true,
    command: 'download',
    file_id: fileId,
    output: outputPath,
    filename,
    bytes: bytes.length,
    content_type: contentType,
  };
}
