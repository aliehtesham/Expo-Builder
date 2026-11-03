'use strict';
/*
 * Google Play Console publishing client.
 *
 * Captures the user's Google account once through OAuth 2.0 for installed
 * apps (PKCE + loopback redirect in the system browser — Google blocks
 * embedded webviews), then registers the project's signing key by uploading
 * the signed AAB through the Play Developer API: the first committed bundle
 * enrolls the app in Play App Signing and the keystore that signed it becomes
 * the upload key. There is no dedicated "register key" endpoint in the API —
 * this upload side effect is the supported path.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { Readable } from 'stream';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const API_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD_ROOT = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';

/** Scopes: publish on the user's behalf + their e-mail address as the account label. */
const SCOPES = 'openid email https://www.googleapis.com/auth/androidpublisher';

/** Thrown for any non-2xx API response; `status` lets callers map common causes. */
export class PlayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * The OAuth client that identifies this app to Google. Desktop/installed
 * apps are public clients: Google treats any issued secret as non-confidential
 * and PKCE is the actual security mechanism, so the secret is optional —
 * newer desktop clients have none at all.
 */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = String(json.error_description || json.error || res.statusText);
    // invalid_grant: the saved refresh token was revoked or expired.
    if (json.error === 'invalid_grant') {
      throw new PlayApiError(`Google refused the saved login (${desc}) — reconnect the account.`, 401);
    }
    throw new PlayApiError(`Google auth failed: ${desc}`, res.status);
  }
  return {
    accessToken: String(json.access_token || ''),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresIn: json.expires_in ? Number(json.expires_in) : undefined,
  };
}

/** One connected account as persisted by the caller. */
export interface GoogleAccount {
  email: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

// ─────────────────────────── OAuth account capture ──────────────────────────

// The in-flight consent flow, so a second connect attempt or app quit can tear
// the loopback listener down instead of leaking it.
let pendingConnect: ((result: { error?: string }) => void) | null = null;

export function cancelPendingConnect(): void {
  if (pendingConnect) pendingConnect({ error: 'Sign-in canceled.' });
}

/**
 * Runs the whole browser consent flow: opens the system browser at Google's
 * consent screen with a loopback redirect, waits for the authorization code,
 * exchanges it for tokens (PKCE) and resolves with the account once a live
 * access token + e-mail could be verified. Resolves/rejects only after the
 * browser round-trip finished (or timed out after 5 minutes).
 */
export async function connectGoogleAccount(
  creds: OAuthClient,
  openUrl: (url: string) => void
): Promise<GoogleAccount> {
  if (pendingConnect) throw new Error('A Google sign-in is already waiting in the browser.');
  if (!/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(creds.clientId)) {
    throw new Error('That does not look like an OAuth client ID — desktop-app client IDs end with ".apps.googleusercontent.com".');
  }

  const verifier = b64url(crypto.randomBytes(48)).slice(0, 96);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  // The loopback redirect actually used (with its ephemeral port) — the token
  // exchange must repeat the exact same value Google saw at consent time.
  let usedRedirectUri = '';
  const granted = await new Promise<{ code: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const finish = (html: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };
      if (url.pathname !== '/callback') {
        finish('<html><body style="font-family:system-ui;padding:40px">Expo Builder sign-in is waiting…</body></html>');
        return;
      }
      const err = url.searchParams.get('error');
      if (err || url.searchParams.get('state') !== state) {
        finish(`<html><body style="font-family:system-ui;padding:40px">Sign-in failed (${err || 'bad state'}). Close this tab and try again from Expo Builder.</body></html>`);
        settle(new Error(err === 'access_denied' ? 'You declined the Google consent — nothing was saved.' : `Google returned an error: ${err || 'state mismatch'}`));
        return;
      }
      finish('<html><body style="font-family:system-ui;padding:40px">Signed in — you can close this tab and return to Expo Builder.</body></html>');
      settle({ code: url.searchParams.get('code') || '' });
    });
    // Everything below must run before the server's 5-minute watchdog fires.
    const settle = (got: { code: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConnect = null;
      server.close();
      if (got instanceof Error) reject(got);
      else if (got.code) resolve(got);
      else reject(new Error('Google did not return an authorization code.'));
    };
    let settled = false;
    const timer = setTimeout(() => settle(new Error('Sign-in timed out after 5 minutes — nothing was saved.')), 300000);

    server.on('error', (err) => settle(new Error(`Could not listen for the sign-in redirect: ${err.message}`)));
    server.listen(0, '127.0.0.1', () => {
      // Desktop-app OAuth clients may use any loopback port without
      // registering it; the URL must be exactly http://127.0.0.1:<port>/… .
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      usedRedirectUri = redirectUri;
      const authUrl =
        `${AUTH_ENDPOINT}?${new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          // offline + consent: a refresh token is only issued on an explicit
          // consent, even for accounts that granted before.
          access_type: 'offline',
          prompt: 'consent',
        }).toString()}`;
      pendingConnect = (r) => settle(new Error(r.error || 'Sign-in canceled.'));
      openUrl(authUrl);
    });
  });

  // Desktop clients are public: the secret is sent only when the client has
  // one — PKCE's code_verifier is what proves the app's identity otherwise.
  const exchange: Record<string, string> = {
    code: granted.code,
    client_id: creds.clientId,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: usedRedirectUri,
  };
  if (creds.clientSecret) exchange.client_secret = creds.clientSecret;
  const tokens = await tokenRequest(exchange);
  if (!tokens.refreshToken) {
    throw new Error('Google did not return a refresh token — tick "Allow" for every permission on the consent screen and try again.');
  }

  // Verify the token is live and label the vault entry with the account e-mail.
  const who = (await apiGet(USERINFO_ENDPOINT, tokens.accessToken)) as { email?: string };
  if (!who.email) throw new Error('Google did not report an e-mail address for this account.');

  return { email: who.email, clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken: tokens.refreshToken };
}

// ─────────────────────────── Play Developer API ─────────────────────────────

async function apiCall(url: string, init: RequestInit, accessToken: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new PlayApiError(await playErrorMessage(res), res.status);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function apiGet(url: string, accessToken: string): Promise<Record<string, unknown>> {
  return apiCall(url, { method: 'GET' }, accessToken);
}

/** Human-readable message from an error response body, e.g. "403: PERMISSION_DENIED — …". */
async function playErrorMessage(res: Response): Promise<string> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const json = (await res.json()) as { error?: { message?: string; status?: string } };
    if (json.error) detail = `${res.status}${json.error.status ? ` ${json.error.status}` : ''}: ${json.error.message || res.statusText}`;
  } catch { /* non-JSON body keeps the status line */ }
  return detail;
}

/** Refreshes the access token with the saved refresh token. */
export async function refreshAccessToken(account: Pick<GoogleAccount, 'clientId' | 'clientSecret' | 'refreshToken'>): Promise<string> {
  const body: Record<string, string> = {
    client_id: account.clientId,
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
  };
  if (account.clientSecret) body.client_secret = account.clientSecret;
  const tokens = await tokenRequest(body);
  return tokens.accessToken;
}

export interface RegisterOptions {
  aabPath: string;
  packageName: string;
  /** Also attach the bundle as a *draft* release on the Internal testing track. */
  draftTrack: boolean;
  releaseName: string;
}

export interface RegisterOutcome {
  /** versionCode Play assigned to the uploaded bundle. */
  versionCode: number | null;
}

/**
 * Registers the keystore that signed `aabPath` as the app's Play upload key:
 * insert edit → upload bundle → (optional) draft internal release → commit.
 * The first committed bundle of a new app enrolls Play App Signing and makes
 * the uploading key the upload key; later commits just publish that version.
 */
export async function registerUploadKey(
  account: GoogleAccount,
  opts: RegisterOptions,
  onEvent: (evt: GoogleEvent) => void
): Promise<RegisterOutcome> {
  const pkgEnc = encodeURIComponent(opts.packageName);
  const accessToken = await refreshAccessToken(account);

  onEvent({ type: 'phase', id: 'edit' });
  const edit = (await apiCall(`${API_ROOT}/applications/${pkgEnc}/edits`, { method: 'POST' }, accessToken)) as { id?: string };
  const editId = edit.id;
  if (!editId) throw new PlayApiError('Play Console did not return an edit id.', 0);

  try {
    onEvent({ type: 'phase', id: 'upload' });
    const size = fs.statSync(opts.aabPath).size;
    onEvent({ type: 'line', text: `Uploading ${opts.aabPath.split(/[\\/]/).pop()} (${size} bytes)…`, stream: 'out' });
    // Media upload, streamed from disk so a 150 MB bundle never sits in RAM.
    const body = Readable.toWeb(fs.createReadStream(opts.aabPath)) as unknown as ReadableStream<Uint8Array>;
    // undici requires `duplex: 'half'` for streaming bodies; the field is
    // missing from older RequestInit typings, hence the double cast.
    const uploadInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body,
      signal: AbortSignal.timeout(600000),
      duplex: 'half',
    } as unknown as RequestInit;
    const bundle = (await apiCall(
      `${UPLOAD_ROOT}/applications/${pkgEnc}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`,
      uploadInit,
      accessToken
    )) as { versionCode?: number };
    const versionCode = bundle.versionCode ?? null;
    onEvent({ type: 'line', text: `Bundle accepted by Play (versionCode ${versionCode ?? 'unknown'}).`, stream: 'out' });

    if (opts.draftTrack) {
      onEvent({ type: 'phase', id: 'track' });
      await apiCall(
        `${API_ROOT}/applications/${pkgEnc}/edits/${encodeURIComponent(editId)}/tracks/internal`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            releases: [{
              name: opts.releaseName,
              // The API models int64 version codes as strings.
              versionCodes: versionCode != null ? [String(versionCode)] : [],
              status: 'draft',
            }],
          }),
        },
        accessToken
      );
      onEvent({ type: 'line', text: 'Draft release added to the Internal testing track.', stream: 'out' });
    }

    onEvent({ type: 'phase', id: 'commit' });
    await apiCall(`${API_ROOT}/applications/${pkgEnc}/edits/${encodeURIComponent(editId)}:commit`, { method: 'POST' }, accessToken);
    return { versionCode };
  } catch (err) {
    // Abandoned edits would hold the package's edit lock for ~12 hours.
    try {
      await apiCall(`${API_ROOT}/applications/${pkgEnc}/edits/${encodeURIComponent(editId)}`, { method: 'DELETE' }, accessToken);
    } catch { /* best effort — the edit also expires on its own */ }
    if (err instanceof PlayApiError) throw mapPlayError(err, opts.packageName);
    throw err;
  }
}

/** Turns raw API failures into the action the user needs to take. */
function mapPlayError(err: PlayApiError, packageName: string): Error {
  if (err.status === 404) {
    return new Error(`No app with package "${packageName}" exists in your Play Console — create it first (All apps → Create app) with exactly this package name.`);
  }
  if (err.status === 403) {
    return new Error(`Play Console refused the call (${err.message}). Usual causes: the "Google Play Android Developer API" is not linked to this app (Play Console → Setup → API access), or the Google account lacks release rights for it.`);
  }
  if (err.status === 401) {
    return new Error(`${err.message} If it persists, reconnect the Google account.`);
  }
  return new Error(err.message);
}
