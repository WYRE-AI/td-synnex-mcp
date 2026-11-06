import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type { CallToolResult };

export type Args = Record<string, unknown>;

export interface ToolDef {
  tool: Tool;
  /** Write tools are hidden and refused in read-only mode. */
  write: boolean;
  handler: (args: Args) => Promise<CallToolResult>;
}
