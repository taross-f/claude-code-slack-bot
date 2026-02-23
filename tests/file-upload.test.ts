import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { cleanupTempFile, processUploadedFile } from '../src/slack/file-upload';
import type { SlackFile } from '../src/utils/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<SlackFile> = {}): SlackFile {
  return {
    id: 'F000TEST',
    name: 'test-file.txt',
    mimetype: 'text/plain',
    size: 100,
    urlPrivate: 'https://files.slack.com/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Image files
// ---------------------------------------------------------------------------

describe('processUploadedFile – images', () => {
  test('JPEG returns kind=image and file exists on disk', async () => {
    const file = makeFile({ name: 'photo.jpg', mimetype: 'image/jpeg', size: 42 });
    const buffer = Buffer.from('fake-jpeg-data');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('unreachable');

    expect(result.tempPath).toMatch(/^\/tmp\/slack-bot-.*\.jpg$/);
    expect(existsSync(result.tempPath)).toBe(true);

    // Cleanup
    cleanupTempFile(result.tempPath);
  });

  test('PNG returns kind=image and file exists on disk', async () => {
    const file = makeFile({ name: 'screenshot.png', mimetype: 'image/png', size: 200 });
    const buffer = Buffer.from('fake-png-data');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('unreachable');

    expect(result.tempPath).toMatch(/^\/tmp\/slack-bot-.*\.png$/);
    expect(existsSync(result.tempPath)).toBe(true);

    cleanupTempFile(result.tempPath);
  });

  test('GIF returns kind=image', async () => {
    const file = makeFile({ name: 'anim.gif', mimetype: 'image/gif', size: 50 });
    const buffer = Buffer.from('fake-gif-data');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('unreachable');
    cleanupTempFile(result.tempPath);
  });

  test('WebP returns kind=image', async () => {
    const file = makeFile({ name: 'pic.webp', mimetype: 'image/webp', size: 80 });
    const buffer = Buffer.from('fake-webp-data');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('unreachable');
    cleanupTempFile(result.tempPath);
  });

  test('written temp file contains the original buffer bytes', async () => {
    const file = makeFile({ name: 'img.png', mimetype: 'image/png', size: 4 });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    const result = await processUploadedFile(file, buffer);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('unreachable');

    const { readFileSync } = await import('node:fs');
    const written = readFileSync(result.tempPath);
    expect(written).toEqual(buffer);

    cleanupTempFile(result.tempPath);
  });
});

// ---------------------------------------------------------------------------
// Text / code files
// ---------------------------------------------------------------------------

describe('processUploadedFile – text files', () => {
  test('.ts file (text/plain mimetype) returns kind=text with UTF-8 content', async () => {
    const content = 'export const hello = "world";';
    const file = makeFile({ name: 'index.ts', mimetype: 'text/plain', size: content.length });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(content);
  });

  test('.md file (text/markdown mimetype) returns kind=text', async () => {
    const content = '# Hello\n\nThis is markdown.';
    const file = makeFile({ name: 'README.md', mimetype: 'text/markdown', size: content.length });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(content);
  });

  test('.json file (application/json mimetype) returns kind=text', async () => {
    const content = '{"key":"value"}';
    const file = makeFile({
      name: 'data.json',
      mimetype: 'application/json',
      size: content.length,
    });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(content);
  });

  test('.yaml file (application/x-yaml mimetype) returns kind=text', async () => {
    const content = 'name: test\nvalue: 42';
    const file = makeFile({
      name: 'config.yaml',
      mimetype: 'application/x-yaml',
      size: content.length,
    });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(content);
  });

  test('application/javascript returns kind=text', async () => {
    const content = 'console.log("hi");';
    const file = makeFile({
      name: 'script.js',
      mimetype: 'application/javascript',
      size: content.length,
    });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(content);
  });

  test('content matches buffer decoded as UTF-8 exactly', async () => {
    const content = 'Unicode: \u00e9\u00e0\u00fc\n';
    const file = makeFile({ name: 'unicode.txt', mimetype: 'text/plain', size: content.length });
    const buffer = Buffer.from(content, 'utf-8');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.content).toBe(buffer.toString('utf-8'));
  });
});

// ---------------------------------------------------------------------------
// Unknown binary files
// ---------------------------------------------------------------------------

describe('processUploadedFile – unknown binary', () => {
  test('.bin file returns kind=skipped', async () => {
    const file = makeFile({
      name: 'data.bin',
      mimetype: 'application/octet-stream',
      size: 100,
    });
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
  });

  test('application/pdf returns kind=skipped', async () => {
    const file = makeFile({ name: 'report.pdf', mimetype: 'application/pdf', size: 1024 });
    const buffer = Buffer.from('%PDF-1.4');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
  });

  test('skipped result includes a reason string', async () => {
    const file = makeFile({ name: 'archive.zip', mimetype: 'application/zip', size: 200 });
    const buffer = Buffer.from('PK\x03\x04');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') throw new Error('unreachable');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Size guard
// ---------------------------------------------------------------------------

describe('processUploadedFile – size guard', () => {
  const MAX_FILE_SIZE = 50 * 1024 * 1024;

  test('file exactly at limit is processed normally (text)', async () => {
    const content = 'x';
    const file = makeFile({
      name: 'ok.txt',
      mimetype: 'text/plain',
      size: MAX_FILE_SIZE,
    });
    const buffer = Buffer.from(content);

    const result = await processUploadedFile(file, buffer);

    // size === limit is allowed (> check in implementation)
    expect(result.kind).toBe('text');
  });

  test('file one byte over limit returns kind=skipped', async () => {
    const file = makeFile({
      name: 'huge.bin',
      mimetype: 'application/octet-stream',
      size: MAX_FILE_SIZE + 1,
    });
    const buffer = Buffer.alloc(10); // buffer itself doesn't matter for this check

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') throw new Error('unreachable');
    expect(result.reason).toMatch(/size/i);
  });

  test('oversized text file returns kind=skipped with reason mentioning size', async () => {
    const file = makeFile({
      name: 'large.txt',
      mimetype: 'text/plain',
      size: MAX_FILE_SIZE + 1000,
    });
    const buffer = Buffer.from('some content');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') throw new Error('unreachable');
    expect(result.reason).toMatch(/size/i);
  });

  test('oversized image returns kind=skipped', async () => {
    const file = makeFile({
      name: 'big.png',
      mimetype: 'image/png',
      size: MAX_FILE_SIZE + 1,
    });
    const buffer = Buffer.from('fake-image');

    const result = await processUploadedFile(file, buffer);

    expect(result.kind).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// cleanupTempFile
// ---------------------------------------------------------------------------

describe('cleanupTempFile', () => {
  test('removes an existing file', () => {
    const path = join('/tmp', `test-cleanup-${Date.now()}.txt`);
    writeFileSync(path, 'temp content');
    expect(existsSync(path)).toBe(true);

    cleanupTempFile(path);

    expect(existsSync(path)).toBe(false);
  });

  test('does not throw when file does not exist', () => {
    const path = '/tmp/does-not-exist-slack-bot-test-12345.txt';
    // Ensure it really doesn't exist
    if (existsSync(path)) cleanupTempFile(path);

    expect(() => cleanupTempFile(path)).not.toThrow();
  });

  test('does not throw when called twice on the same path', () => {
    const path = join('/tmp', `test-double-cleanup-${Date.now()}.txt`);
    writeFileSync(path, 'data');

    cleanupTempFile(path);
    expect(() => cleanupTempFile(path)).not.toThrow();
  });
});
