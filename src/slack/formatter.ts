/** Convert Markdown to Slack mrkdwn syntax. */
export function toSlackMarkdown(text: string): string {
  return (
    text
      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Headings → bold
      .replace(/^#{1,3} (.+)$/gm, '*$1*')
      // Unordered lists
      .replace(/^[-*] /gm, '• ')
      // Code blocks: keep triple backticks (Slack supports them)
      .replace(/```(\w+)?\n([\s\S]+?)```/g, (_m, _lang, code) => `\`\`\`${code}\`\`\``)
  );
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}...`;
}

/** One-line description of a Claude tool call for status messages. */
export function formatToolDescription(tool: string, input: unknown): string {
  const inp = input as Record<string, unknown>;
  switch (tool) {
    case 'Read':
      return `👁️ \`${inp.file_path}\``;
    case 'Edit':
    case 'MultiEdit':
      return `📝 \`${inp.file_path}\``;
    case 'Write':
      return `📄 \`${inp.file_path}\``;
    case 'Bash':
      return `🖥️ \`${truncate(String(inp.command ?? ''), 80)}\``;
    case 'Glob':
      return `🔍 \`${inp.pattern}\``;
    case 'Grep':
      return `🔎 \`${inp.pattern}\``;
    case 'TodoWrite':
      return '📋 Updating task list';
    default:
      return `🔧 ${tool}`;
  }
}
