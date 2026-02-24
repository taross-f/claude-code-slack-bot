import { describe, expect, it } from 'bun:test';
import { formatToolDescription, toSlackMarkdown, truncate } from '../src/slack/formatter';

describe('toSlackMarkdown', () => {
  it('converts **bold** to *bold*', () => {
    expect(toSlackMarkdown('**hello world**')).toBe('*hello world*');
  });

  it('converts ## Heading to *Heading*', () => {
    expect(toSlackMarkdown('## My Heading')).toBe('*My Heading*');
  });

  it('converts # h1 heading to *heading*', () => {
    expect(toSlackMarkdown('# Top Level')).toBe('*Top Level*');
  });

  it('converts ### h3 heading to *heading*', () => {
    expect(toSlackMarkdown('### Sub Section')).toBe('*Sub Section*');
  });

  it('converts - list items to bullet points', () => {
    expect(toSlackMarkdown('- item one')).toBe('• item one');
  });

  it('converts * list items to bullet points', () => {
    expect(toSlackMarkdown('* item two')).toBe('• item two');
  });

  it('preserves code blocks by stripping language tag', () => {
    const input = '```typescript\nconst x = 1;\n```';
    const result = toSlackMarkdown(input);
    expect(result).toContain('const x = 1;');
    expect(result).toMatch(/^```/);
  });

  it('passes through plain text unchanged', () => {
    expect(toSlackMarkdown('hello world')).toBe('hello world');
  });

  it('preserves inline code unchanged', () => {
    expect(toSlackMarkdown('use `console.log`')).toBe('use `console.log`');
  });
});

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns string unchanged when length equals maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates long strings and appends ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('truncates at exact maxLength characters before the ellipsis', () => {
    const result = truncate('abcdefgh', 4);
    expect(result).toBe('abcd...');
  });
});

describe('formatToolDescription', () => {
  it('formats Read tool with file path and eye emoji', () => {
    const result = formatToolDescription('Read', { file_path: '/foo/bar.ts' });
    expect(result).toBe('👁️ `/foo/bar.ts`');
  });

  it('formats Edit tool with file path and pencil emoji', () => {
    const result = formatToolDescription('Edit', { file_path: '/src/index.ts' });
    expect(result).toBe('📝 `/src/index.ts`');
  });

  it('formats MultiEdit tool the same as Edit', () => {
    const result = formatToolDescription('MultiEdit', { file_path: '/src/app.ts' });
    expect(result).toBe('📝 `/src/app.ts`');
  });

  it('formats Write tool with file path and page emoji', () => {
    const result = formatToolDescription('Write', { file_path: '/out/file.txt' });
    expect(result).toBe('📄 `/out/file.txt`');
  });

  it('formats Bash tool with command and terminal emoji', () => {
    const result = formatToolDescription('Bash', { command: 'npm install' });
    expect(result).toBe('🖥️ `npm install`');
  });

  it('truncates Bash commands longer than 80 characters', () => {
    const longCmd = 'x'.repeat(200);
    const result = formatToolDescription('Bash', { command: longCmd });
    expect(result).toContain('...');
    // The command portion is truncated to 80 chars + '...'
    expect(result).toBe(`🖥️ \`${'x'.repeat(80)}...\``);
  });

  it('formats Glob tool with pattern and search emoji', () => {
    const result = formatToolDescription('Glob', { pattern: '**/*.ts' });
    expect(result).toBe('🔍 `**/*.ts`');
  });

  it('formats Grep tool with pattern and search emoji', () => {
    const result = formatToolDescription('Grep', { pattern: 'TODO' });
    expect(result).toBe('🔎 `TODO`');
  });

  it('formats TodoWrite tool with clipboard description', () => {
    const result = formatToolDescription('TodoWrite', {});
    expect(result).toBe('📋 Updating task list');
  });

  it('formats unknown tool generically with wrench emoji', () => {
    const result = formatToolDescription('MyCustomTool', {});
    expect(result).toBe('🔧 MyCustomTool');
  });
});
