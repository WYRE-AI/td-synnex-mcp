/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders never count. /mcp rejects a missing or invalid
 * X-Gateway-S2S header. AUTH_MODE=gateway rejects requests that carry no
 * X-TDSynnex-* credential headers and must not fall back to TDSYNNEX_* in
 * process.env. Request bodies over 1 MB get 413.
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHttpServer } from '../http.js';
import { resetAuthState } from '../client.js';
import { clearConsumedTokens } from '../order-safety.js';

const S2S_SECRET = 's2s-do-not-log-7f3a-0123456789abcdef-padding';
const ENV_ACCOUNT = '999111';
const ENV_TOKEN = 'env-access-token-must-not-be-used';
const HEADER_ACCOUNT = '777000';
const HEADER_TOKEN = 'header-access-token-must-not-leak';
const credHeaders = (): Record<string, string> => ({
  'x-tdsynnex-account-id': HEADER_ACCOUNT,
  'x-tdsynnex-access-token': HEADER_TOKEN,
});
const PLACEHOLDER = 'replace-with-a-real-secret';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'TDSYNNEX_ACCOUNT_ID',
  'TDSYNNEX_ACCESS_TOKEN',
  'TDSYNNEX_REFRESH_TOKEN',
  'TDSYNNEX_REFRESH_TOKEN_FILE',
  'TDSYNNEX_CONFIRM_SECRET',
  'READ_ONLY_MODE',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const listTools = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
});

const customersCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'tdsynnex_list_customers', arguments: { pageSize: 5 } },
});

const cancelCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'tdsynnex_cancel_order', arguments: { customerId: '1', orderId: '2' } },
});

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_ACCOUNT);
  expect(text).not.toContain(ENV_TOKEN);
  expect(text).not.toContain(HEADER_ACCOUNT);
  expect(text).not.toContain(HEADER_TOKEN);
  expect(text).not.toContain(PLACEHOLDER);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  for (const k of ['TDSYNNEX_ACCOUNT_ID', 'TDSYNNEX_ACCESS_TOKEN', 'TDSYNNEX_REFRESH_TOKEN', 'TDSYNNEX_REFRESH_TOKEN_FILE', 'TDSYNNEX_CONFIRM_SECRET', 'READ_ONLY_MODE']) delete process.env[k];
  delete process.env.MCP_TRANSPORT;
  resetAuthState();
  clearConsumedTokens();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it.each(['changeme', 'replace-with-a-real-secret', '  Your-S2S-Secret  '])(
    'refuses known placeholder secret %j and does not log it',
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startHttpServer()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain('known placeholder');
        expect(text).toContain('openssl rand -hex 32');
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain('Your-S2S-Secret');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it.each([
    ['without the dev flag', undefined],
    ['even when MCP_ALLOW_INSECURE_DEV=1', '1'],
  ])('refuses a CONDUIT_S2S_SECRET under 32 bytes %s and does not log it', async (_label, devFlag) => {
    const shortSecret = 'short-secret-value-31-bytes-xxx';
    expect(Buffer.byteLength(shortSecret, 'utf8')).toBe(31);
    process.env.CONDUIT_S2S_SECRET = shortSecret;
    if (devFlag) process.env.MCP_ALLOW_INSECURE_DEV = devFlag;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('at least 32 bytes');
      expect(text).toContain('openssl rand -hex 32');
      expect(text).not.toContain(shortSecret);
      expect(text).not.toContain('SECURITY WARNING');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('accepts a multibyte secret that is under 32 characters but at least 32 bytes', async () => {
    const multibyte = 'é'.repeat(16);
    expect(multibyte.length).toBeLessThan(32);
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(32);
    process.env.CONDUIT_S2S_SECRET = multibyte;
    const exitSpy = mockExit();

    await listen();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1', async () => {
    process.env.CONDUIT_S2S_SECRET = 'changeme';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).not.toContain('SECURITY WARNING');
      expect(text).not.toContain('changeme');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      const server = await listen();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'overrides non-loopback MCP_HTTP_HOST=%s when the dev bypass is on',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        const server = await listen();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('forces 127.0.0.1 when the dev bypass host is localhost', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = 'localhost';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      expect(logs.text()).toContain('SECURITY WARNING');
      expect(logs.text()).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('binds 0.0.0.0 when a secret is set and MCP_HTTP_HOST is unset', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe('0.0.0.0');
  });
});

describe('HTTP /mcp authentication (AUTH_MODE=gateway)', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.TDSYNNEX_ACCOUNT_ID = ENV_ACCOUNT;
    process.env.TDSYNNEX_ACCESS_TOKEN = ENV_TOKEN;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ ...credHeaders() }),
        body: listTools,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader('wrong-secret'), ...credHeaders() }),
        body: listTools,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      expect(invalid.body).toContain('X-Gateway-S2S');
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 without credential headers and never uses env credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();

    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: customersCall,
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain('Unauthorized');
    expect(response.body).toContain('x-tdsynnex-account-id');
    expect(response.body).toContain('x-tdsynnex-access-token');
    assertNoSecrets(response.body);

    // Either header alone is not enough.
    for (const only of [{ 'x-tdsynnex-account-id': HEADER_ACCOUNT }, { 'x-tdsynnex-access-token': HEADER_TOKEN }] as Array<Record<string, string>>) {
      const partial = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...only }),
        body: customersCall,
      });
      expect(partial.status).toBe(401);
      expect(partial.body).toContain('missing required gateway credential header');
      assertNoSecrets(partial.body);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['non-numeric account id', { 'x-tdsynnex-account-id': '12/../34' }],
    ['malformed token', { 'x-tdsynnex-access-token': 'bad token with spaces' }],
  ])('returns 401 for a %s', async (_label, override) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders(), ...override }),
      body: customersCall,
    });
    expect(response.status).toBe(401);
    assertNoSecrets(response.body);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus credential headers, uses the header token and account, and does not exchange tokens', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ customers: [] }));

    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders() }),
        body: customersCall,
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(String(url)).toContain(`/accounts/${HEADER_ACCOUNT}/customers`);
      expect(String(url)).not.toContain(ENV_ACCOUNT);
      expect(init.headers.Authorization).toBe(`Bearer ${HEADER_TOKEN}`);
      assertNoSecrets(response.body);
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({ port: server.port, method: 'GET', path: '/health' });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; mode?: string; credentials?: unknown };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(body.credentials).toBeUndefined();
    assertNoSecrets(response.body);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tools/list hides write tools by default and lists them with READ_ONLY_MODE=false', async () => {
    const server = await listen();
    const headers = mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders() });
    const names = async () => {
      const r = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers, body: listTools });
      expect(r.status).toBe(200);
      return (JSON.parse(r.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    };
    const readOnly = await names();
    expect(readOnly).toContain('tdsynnex_list_customers');
    expect(readOnly).not.toContain('tdsynnex_create_order');

    process.env.READ_ONLY_MODE = 'false';
    const writable = await names();
    expect(writable).toContain('tdsynnex_create_order');
    expect(writable.length).toBeGreaterThan(readOnly.length);
  });

  it('refuses a write tool call over HTTP in read-only mode without contacting TD SYNNEX', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const r = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders() }),
      body: cancelCall,
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HTTP request body cap', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  const headers = () => mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders() });

  it('answers 413 when the body is over 1 MB', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'tdsynnex_list_customers', arguments: { customerName: 'x'.repeat(1024 * 1024 + 10) } },
    });
    const r = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: headers(), body: big });
    expect(r.status).toBe(413);
    expect(r.body).toContain('too large');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still serves a normal-size body and the 413 check happens after S2S auth', async () => {
    const server = await listen();
    const ok = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: headers(), body: listTools });
    expect(ok.status).toBe(200);
    const unauth = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ ...credHeaders() }),
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(unauth.status).toBe(401);
  });

  it('answers 400 for invalid JSON', async () => {
    const server = await listen();
    const r = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: headers(), body: '{not json' });
    expect(r.status).toBe(400);
  });
});

describe('HTTP AUTH_MODE=env', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.TDSYNNEX_ACCOUNT_ID = ENV_ACCOUNT;
    process.env.TDSYNNEX_ACCESS_TOKEN = ENV_TOKEN;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('accepts a signed request that omits vendor headers and uses env credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse({ customers: [] }));

    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: customersCall,
    });

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(String(url)).toContain(`/accounts/${ENV_ACCOUNT}/customers`);
    expect(init.headers.Authorization).toBe(`Bearer ${ENV_TOKEN}`);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_TOKEN);
  });

  it('still requires a valid S2S header', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: mcpHeaders(), body: customersCall });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HTTP request handler errors', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('answers 500 JSON when request handling throws, logs without secrets, and keeps serving', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const logs = captureStderr();
    try {
      const server = await listen();
      // An unparsable Host header makes `new URL(...)` throw inside the handler.
      const bad = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ host: 'bad host', 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
        body: listTools,
      });
      expect(bad.status).toBe(500);
      expect(JSON.parse(bad.body)).toEqual({ error: 'Internal server error' });
      assertNoSecrets(bad.body);
      assertNoSecrets(logs.text());
      expect(logs.text()).toContain('Unhandled error while handling request');

      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);

      const health = await sendHttp({ port: server.port, method: 'GET', path: '/health' });
      expect(health.status).toBe(200);
    } finally {
      logs.restore();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a non-ConfigError while parsing credential headers also yields 500, not a crash', async () => {
    const config = await import('../config.js');
    const spy = vi.spyOn(config, 'credentialsFromHeaders').mockImplementation(() => {
      throw new Error('boom: unexpected parse failure');
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const server = await listen();
      const res = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET), ...credHeaders() }),
        body: customersCall,
      });
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error' });
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses to start the HTTP server on an invalid order cap or confirm secret', async () => {
    process.env.TDSYNNEX_MAX_ORDER_LINES = '0';
    try {
      await expect(startHttpServer()).rejects.toThrow(/TDSYNNEX_MAX_ORDER_LINES/);
    } finally {
      delete process.env.TDSYNNEX_MAX_ORDER_LINES;
    }
    process.env.TDSYNNEX_CONFIRM_SECRET = 'short';
    await expect(startHttpServer()).rejects.toThrow(/TDSYNNEX_CONFIRM_SECRET/);
  });
});
