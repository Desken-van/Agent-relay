import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackFetch } from '../../src/main/adapters/local-inference/loopback-fetch';

const servers: Server[] = [];

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; seen: { method: string; body: string }[] }> {
  const seen: { method: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', body });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, seen };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('loopbackFetch', () => {
  it('waits for a completion whose headers come after more than five minutes, as long as the caller allows', async () => {
    // Virtual time: the runtime answers only after six minutes of generation.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let received: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => { received = resolve; });
    const { url } = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"done":true}');
      }, 6 * 60_000);
      received();
    });

    const pending = loopbackFetch(url, { method: 'POST', body: '{}', redirect: 'error' });
    await arrived;
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    for (let minute = 0; minute < 5; minute += 1) await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(61_000);
    vi.useRealTimers();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"done":true}');
  });

  it('sends the body once and returns status, headers and the streamed body', async () => {
    const { url, seen } = await serve((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-runtime': 'fake' });
      res.end(JSON.stringify({ ok: true, text: 'ünïcode' }));
    });

    const response = await loopbackFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"é"}' });

    expect(seen).toEqual([{ method: 'POST', body: '{"prompt":"é"}' }]);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-runtime')).toBe('fake');
    expect(await response.json()).toEqual({ ok: true, text: 'ünïcode' });
  });

  it('refuses a redirect when asked to, without following it', async () => {
    const second = await serve((_req, res) => res.end('{}'));
    const { url } = await serve((_req, res) => {
      res.writeHead(307, { location: second.url });
      res.end();
    });

    await expect(loopbackFetch(url, { method: 'POST', body: '{}', redirect: 'error' })).rejects.toThrow(TypeError);
    expect(second.seen).toHaveLength(0);
  });

  it('stops waiting the moment the caller aborts, before or after the headers', async () => {
    const waiting = await serve(() => undefined);
    const before = new AbortController();
    const pending = loopbackFetch(waiting.url, { method: 'POST', body: '{}', signal: before.signal });
    setTimeout(() => before.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const streaming = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
    });
    const during = new AbortController();
    const response = await loopbackFetch(streaming.url, { method: 'POST', body: '{}', signal: during.signal });
    const reading = response.text();
    during.abort();
    await expect(reading).rejects.toBeDefined();

    const already = new AbortController();
    already.abort();
    await expect(loopbackFetch(waiting.url, { method: 'GET', signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('speaks only plain HTTP to a loopback address', async () => {
    for (const url of ['https://127.0.0.1:1/health', 'http://example.com/health', 'http://10.0.0.1:8080/health', 'file:///etc/hosts']) {
      await expect(loopbackFetch(url, { method: 'GET' })).rejects.toThrow(TypeError);
    }
  });

  it('reports a connection that is refused as a failed fetch', async () => {
    const { url } = await serve(() => undefined);
    const port = new URL(url).port;
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    await expect(loopbackFetch(`http://127.0.0.1:${port}/health`, { method: 'GET' })).rejects.toThrow('fetch failed');
  });
});
