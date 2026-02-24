import { describe, expect, test } from 'bun:test';
import { formatToolDescription, toSlackMarkdown, truncate } from '../../../src/slack/formatter';

describe('toSlackMarkdown', () => {
  test('converts **bold** to *bold*', () => {
    expect(toSlackMarkdown('**hello**')).toBe('*hello*');
  });

  test('converts # heading to *heading*', () => {
    expect(toSlackMarkdown('## Section Title')).toBe('*Section Title*');
  });

  test('converts unordered list markers', () => {
    expect(toSlackMarkdown('- item one')).toBe('• item one');
  });

  test('preserves inline code', () => {
    expect(toSlackMarkdown('use `console.log`')).toBe('use `console.log`');
  });

  test('preserves code blocks', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const result = toSlackMarkdown(input);
    expect(result).toContain('const x = 1;');
  });

  test('passes through plain text unchanged', () => {
    expect(toSlackMarkdown('hello world')).toBe('hello world');
  });
});

describe('truncate', () => {
  test('returns string unchanged when shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  test('returns string unchanged when equal to limit', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  test('truncates and appends ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });
});

describe('formatToolDescription', () => {
  test('formats Read tool', () => {
    const result = formatToolDescription('Read', { file_path: '/foo/bar.ts' });
    expect(result).toContain('/foo/bar.ts');
    expect(result).toContain('👁️');
  });

  test('formats Edit tool', () => {
    const result = formatToolDescription('Edit', { file_path: '/foo/bar.ts' });
    expect(result).toContain('/foo/bar.ts');
    expect(result).toContain('📝');
  });

  test('formats Bash tool with command', () => {
    const result = formatToolDescription('Bash', { command: 'npm install' });
    expect(result).toContain('npm install');
    expect(result).toContain('🖥️');
  });

  test('truncates long Bash commands', () => {
    const longCmd = 'a'.repeat(200);
    const result = formatToolDescription('Bash', { command: longCmd });
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('...');
  });

  test('formats unknown tool generically', () => {
    const result = formatToolDescription('CustomTool', {});
    expect(result).toContain('CustomTool');
    expect(result).toContain('🔧');
  });
});
