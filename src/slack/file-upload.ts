import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Logger } from '../utils/logger';
import type { SlackFile } from '../utils/types';

const logger = new Logger('FileUpload');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export type FileProcessResult =
  | { kind: 'image'; tempPath: string }
  | { kind: 'text'; content: string }
  | { kind: 'skipped'; reason: string };

/** Returns true for mimetypes we embed as text in the prompt. */
function isTextMimetype(mimetype: string): boolean {
  return (
    mimetype.startsWith('text/') ||
    mimetype === 'application/json' ||
    mimetype === 'application/xml' ||
    mimetype === 'application/javascript' ||
    mimetype === 'application/typescript' ||
    mimetype === 'application/x-yaml' ||
    mimetype === 'application/x-sh'
  );
}

/** Returns true for image mimetypes we write to tmp and pass as a path. */
function isImageMimetype(mimetype: string): boolean {
  return (
    mimetype === 'image/jpeg' ||
    mimetype === 'image/jpg' ||
    mimetype === 'image/png' ||
    mimetype === 'image/gif' ||
    mimetype === 'image/webp'
  );
}

/**
 * Process an uploaded Slack file buffer into a structured result.
 *
 * - Images (jpg/png/gif/webp): written to /tmp and returned as `{ kind: 'image', tempPath }`.
 * - Text/code files: decoded as UTF-8 and returned as `{ kind: 'text', content }`.
 * - Oversized files: returned as `{ kind: 'skipped', reason }` without processing.
 * - Other binary files: returned as `{ kind: 'skipped', reason }` with a log warning.
 */
export async function processUploadedFile(
  file: SlackFile,
  buffer: Buffer
): Promise<FileProcessResult> {
  if (file.size > MAX_FILE_SIZE) {
    const reason = `File "${file.name}" exceeds size limit (${file.size} bytes > ${MAX_FILE_SIZE} bytes)`;
    logger.warn('File exceeds size limit, skipping', { name: file.name, size: file.size });
    return { kind: 'skipped', reason };
  }

  if (isImageMimetype(file.mimetype)) {
    const ext = extname(file.name) || '.img';
    const tempPath = join('/tmp', `slack-bot-${randomUUID()}${ext}`);
    writeFileSync(tempPath, buffer);
    logger.debug('Image saved to temp file', { name: file.name, tempPath });
    return { kind: 'image', tempPath };
  }

  if (isTextMimetype(file.mimetype)) {
    const content = buffer.toString('utf-8');
    logger.debug('Text file decoded', { name: file.name, bytes: buffer.length });
    return { kind: 'text', content };
  }

  const reason = `File "${file.name}" has unsupported binary mimetype: ${file.mimetype}`;
  logger.warn('Unsupported binary file type, skipping', {
    name: file.name,
    mimetype: file.mimetype,
  });
  return { kind: 'skipped', reason };
}

/**
 * Safely remove a temporary file. Does not throw if the file no longer exists.
 */
export function cleanupTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    // Ignore ENOENT (file already gone) and other non-fatal errors
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Failed to remove temp file', { path, err });
    }
  }
}
