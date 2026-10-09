/**
 * The HTTP client a local runtime is spoken to with, in production.
 *
 * Not the global `fetch`: its client (undici) gives up on a response whose headers have not arrived within
 * 300 seconds (`headersTimeout`), whatever deadline the caller set. A non-streaming completion sends its headers
 * only once generation is done, so every inference longer than five minutes failed as "did not complete" while
 * the profile allowed up to 30 — reproduced with a real Strata run on a machine short of RAM.
 *
 * This client has no timeout of its own: the caller's signal is the only bound (the adapter's `Deadline`, i.e.
 * the profile's own timeout and cancellation). It speaks plain HTTP to a loopback address and nothing else, opens
 * one connection per request, never follows a redirect (`redirect: 'error'` rejects on a 3xx, as `fetch` does),
 * and hands back a standard `Response` whose body the caller reads within its own bounds.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { FetchLike } from './llama-cpp-local-inference';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function abortError(): DOMException {
  return new DOMException('This operation was aborted', 'AbortError');
}

export const loopbackFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
      reject(new TypeError('Only plain HTTP to a loopback address is supported.'));
      return;
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : init.body === undefined || init.body === null ? null : undefined;
    if (body === undefined) {
      reject(new TypeError('Only a text request body is supported.'));
      return;
    }
    if (body !== null) headers.set('content-length', String(Buffer.byteLength(body)));

    let response: IncomingMessage | null = null;
    const request = httpRequest(target, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers),
      agent: false
    });
    const onAbort = (): void => {
      const error = abortError();
      request.destroy(error);
      response?.destroy(error);
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const release = (): void => signal?.removeEventListener('abort', onAbort);

    request.on('error', (error) => {
      release();
      reject(new TypeError('fetch failed', { cause: error }));
    });
    request.on('response', (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400 && init.redirect === 'error') {
        incoming.destroy();
        release();
        reject(new TypeError('fetch failed', { cause: new Error('A redirect was refused.') }));
        return;
      }
      incoming.once('close', release);
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
      }
      const nullBody = status === 204 || status === 304 || (init.method ?? 'GET') === 'HEAD';
      if (nullBody) incoming.resume();
      try {
        resolve(new Response(nullBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
          status,
          statusText: incoming.statusMessage ?? '',
          headers: responseHeaders
        }));
      } catch (error) {
        // A status `Response` cannot represent (outside 200–599) is not an answer.
        incoming.destroy();
        release();
        reject(new TypeError('fetch failed', { cause: error }));
      }
    });
    request.end(body ?? undefined);
  });
