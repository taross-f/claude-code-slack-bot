import { describe, expect, it } from 'bun:test';
import { buildPermissionBlock } from '../src/slack/blocks';

describe('buildPermissionBlock', () => {
  it('returns an array of exactly 3 blocks', () => {
    const blocks = buildPermissionBlock('approval-1', 'Bash', { command: 'ls' });
    expect(blocks).toHaveLength(3);
  });

  it('first block is a section with tool name', () => {
    const blocks = buildPermissionBlock('approval-1', 'Bash', { command: 'ls' });
    const first = blocks[0] as Record<string, unknown>;
    expect(first.type).toBe('section');
    const text = first.text as Record<string, unknown>;
    expect(text.type).toBe('mrkdwn');
    expect(String(text.text)).toContain('Bash');
    expect(String(text.text)).toContain('Permission Required');
  });

  it('second block is a section containing the input preview', () => {
    const blocks = buildPermissionBlock('approval-2', 'Read', { file_path: '/etc/passwd' });
    const second = blocks[1] as Record<string, unknown>;
    expect(second.type).toBe('section');
    const text = second.text as Record<string, unknown>;
    expect(String(text.text)).toContain('/etc/passwd');
  });

  it('third block is an actions block with Allow and Deny buttons', () => {
    const blocks = buildPermissionBlock('approval-3', 'Write', { file_path: '/tmp/out.txt' });
    const actions = blocks[2] as Record<string, unknown>;
    expect(actions.type).toBe('actions');

    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(2);

    const allow = elements[0];
    expect((allow.text as Record<string, unknown>).text).toBe('Allow');
    expect(allow.style).toBe('primary');
    expect(allow.action_id).toBe('approve_tool');

    const deny = elements[1];
    expect((deny.text as Record<string, unknown>).text).toBe('Deny');
    expect(deny.style).toBe('danger');
    expect(deny.action_id).toBe('deny_tool');
  });

  it('approvalId appears in both button values', () => {
    const id = 'my-approval-uuid-1234';
    const blocks = buildPermissionBlock(id, 'Edit', { file_path: '/src/app.ts' });
    const actions = blocks[2] as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;

    expect(elements[0].value).toBe(id);
    expect(elements[1].value).toBe(id);
  });

  it('truncates preview at 400 characters for long inputs', () => {
    const longInput = { data: 'x'.repeat(500) };
    const blocks = buildPermissionBlock('approval-4', 'Bash', longInput);
    const second = blocks[1] as Record<string, unknown>;
    const text = second.text as Record<string, unknown>;
    const preview = String(text.text);

    // The raw JSON is > 400 chars, so it must end with '...' before the closing ```
    expect(preview).toContain('...');
    // The raw JSON slice should be exactly 400 chars
    const raw = JSON.stringify(longInput, null, 2);
    expect(raw.length).toBeGreaterThan(400);
    expect(preview).toContain(raw.slice(0, 400));
  });

  it('does not truncate short inputs', () => {
    const shortInput = { command: 'ls' };
    const blocks = buildPermissionBlock('approval-5', 'Bash', shortInput);
    const second = blocks[1] as Record<string, unknown>;
    const text = second.text as Record<string, unknown>;
    const preview = String(text.text);

    const raw = JSON.stringify(shortInput, null, 2);
    expect(raw.length).toBeLessThanOrEqual(400);
    // The full JSON should appear in the preview without truncation suffix
    expect(preview).toContain(raw);
    // The preview section should not end with '...' before the closing ```
    expect(preview).not.toContain('...');
  });
});
