import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { isReadOnlyMode } from '../config.js';
import { READ_TOOLS } from './read.js';
import { WRITE_TOOLS } from './write.js';
import { errorResult, toErrorResult } from './shared.js';
import type { CallToolResult, ToolDef } from './types.js';

const DEFS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** Every tool the server can offer. tools/list uses listTools(), which hides write tools in read-only mode. */
export const ALL_TOOLS: Tool[] = DEFS.map((d) => d.tool);

const BY_NAME = new Map(DEFS.map((d) => [d.tool.name, d]));

/** Tools to advertise: write tools only when READ_ONLY_MODE is exactly "false". */
export function listTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  const readOnly = isReadOnlyMode(env);
  return DEFS.filter((d) => !(readOnly && d.write)).map((d) => d.tool);
}

export const READ_ONLY_REFUSAL =
  'This connection is read-only (READ_ONLY_MODE is not "false"), so this tool changes nothing and was not run. Tell the user that write operations are disabled for this connection; an administrator can enable them by setting READ_ONLY_MODE=false.';

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const d = BY_NAME.get(name);
  if (!d) return errorResult(`Unknown tool: ${name}`);
  if (d.write && isReadOnlyMode()) return errorResult(READ_ONLY_REFUSAL);
  try {
    return await d.handler(args);
  } catch (err) {
    return toErrorResult(err, name);
  }
}
