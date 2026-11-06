import { vi } from 'vitest';
import { resetAuthState } from '../client.js';
import { clearConsumedTokens } from '../order-safety.js';
import { dispatchToolCall } from '../tools/index.js';

export const ACCOUNT = '1234';
export const STATIC_TOKEN = 'static-access-token-aaaa1111';

export const ENV_KEYS = [
  'TDSYNNEX_ACCOUNT_ID',
  'TDSYNNEX_ACCESS_TOKEN',
  'TDSYNNEX_REFRESH_TOKEN',
  'TDSYNNEX_REFRESH_TOKEN_FILE',
  'TDSYNNEX_CONFIRM_SECRET',
  'TDSYNNEX_MAX_ORDER_LINES',
  'TDSYNNEX_MAX_LINE_QUANTITY',
  'READ_ONLY_MODE',
] as const;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}

/** Stubs global fetch with a queue of responses (or a function) and records every call. */
export function mockFetch(responder: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | FormData | undefined,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** Clean env + auth state, then configure static-token env credentials for tool tests. */
export function resetEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  resetAuthState();
  clearConsumedTokens();
}

export function useStaticCreds(): void {
  resetEnv();
  process.env.TDSYNNEX_ACCOUNT_ID = ACCOUNT;
  process.env.TDSYNNEX_ACCESS_TOKEN = STATIC_TOKEN;
}

/** Calls a tool and returns the raw result plus its parsed JSON (when the text is JSON). */
export async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await dispatchToolCall(name, args);
  const text = (result.content[0] as { text: string }).text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json: json as Record<string, any> | undefined, isError: result.isError === true };
}
