type Block = Record<string, unknown>;

export function buildPermissionBlock(approvalId: string, tool: string, input: unknown): Block[] {
  const raw = JSON.stringify(input, null, 2);
  const preview = raw.length > 400 ? `${raw.slice(0, 400)}...` : raw;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Permission Required*\nTool: \`${tool}\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${preview}\n\`\`\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: 'approve_tool',
          value: approvalId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: 'deny_tool',
          value: approvalId,
        },
      ],
    },
  ];
}
