'use strict';
// HTTP(S) GET for the dependency downloads. Inside Electron the request goes
// through Chromium's network stack (net.request), which honors the system
// proxy and PAC scripts — dl.google.com is blocked outright on some networks
// and only reachable via the user's local proxy, which plain Node https calls
// would never see. Outside Electron (CLI smoke runs of lib/*.js) it falls back
// to plain Node https.
//
// Some filtering networks treat the two stacks differently — they throttle or
// reset one TLS fingerprint while letting the other through. So when the
// Chromium request dies before yielding any response, the same GET is retried
// transparently on Node's stack before the error is reported.

import type { ClientRequest } from 'http';
import * as https from 'https';

/** The slice of an HTTP response the download helpers rely on. */
export interface HttpGetResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: (...args: never[]) => void): unknown;
  resume(): void;
  pipe<T>(dest: T): T;
}

/** The slice of a request the download helpers rely on (destroy cancels). */
export interface HttpGetRequest {
  setHeader(name: string, value: string): void;
  on(event: string, cb: (...args: never[]) => void): unknown;
  end(): void;
  destroy(): void;
}

export function httpGet(
  url: string,
  headers: Record<string, string>,
  onResponse: (res: HttpGetResponse) => void
): HttpGetRequest {
  let errorCb: ((e: Error) => void) | null = null;
  let gotResponse = false;
  let destroyed = false;
  let fallbackStarted = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackReq: ClientRequest | null = null;

  let net: Electron.Net | null = null;
  try {
    const electron = require('electron') as { net?: Electron.Net };
    if (electron && electron.net) net = electron.net;
  } catch {
    /* pure-Node context (CLI) — https-only path below */
  }

  const startHttpsFallback = (netErr: Error): void => {
    if (fallbackStarted || destroyed || gotResponse) {
      if (fallbackStarted && errorCb && !gotResponse) errorCb(netErr);
      return;
    }
    fallbackStarted = true;
    try {
      const req = https.get(url, { headers }, (res) => {
        gotResponse = true;
        onResponse(res as unknown as HttpGetResponse);
      });
      fallbackReq = req;
      req.on('error', (e: Error) => {
        if (errorCb) errorCb(new Error(`${netErr.message}; https fallback: ${e.message}`));
      });
    } catch (e) {
      if (errorCb) errorCb(netErr);
    }
  };

  if (net) {
    // Electron: follows redirects itself and resolves the system proxy.
    const req = net.request({ url, redirect: 'follow' });
    req.on('response', (res) => {
      gotResponse = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      onResponse(res as unknown as HttpGetResponse);
    });
    req.on('error', (e) => {
      // Errors after the response started (dropped mid-body) go straight to
      // the caller — a half-downloaded file cannot be retried transparently.
      if (gotResponse || destroyed || fallbackStarted) {
        if (errorCb) errorCb(e);
        return;
      }
      startHttpsFallback(e);
    });
    // Some filtering middle boxes don't refuse Chromium's TLS — they accept
    // and then black-hole it, so no error ever fires. If no response headers
    // arrive within a few seconds, switch to Node's stack on the same URL.
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      if (gotResponse || destroyed || fallbackStarted) return;
      startHttpsFallback(new Error('Chromium request stalled'));
      try { req.abort(); } catch { /* already gone */ }
    }, 8000);
    return {
      setHeader: (name, value) => req.setHeader(name, value),
      on: (event, cb) => {
        if (event === 'error') errorCb = cb as unknown as (e: Error) => void;
        return req.on(event as never, cb as never);
      },
      end: () => req.end(),
      destroy: () => {
        destroyed = true;
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        req.abort();
        if (fallbackReq) fallbackReq.destroy();
      },
    };
  }

  return https.get(url, { headers }, onResponse as never) as unknown as HttpGetRequest;
}
