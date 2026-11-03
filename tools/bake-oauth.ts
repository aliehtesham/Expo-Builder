'use strict';
/*
 * Expo Builder — OAuth client baker.
 *
 * Re-encodes the shipped Google OAuth client ID into main.ts
 * (OAUTH_ID_KEY / OAUTH_ID_DATA). Run after creating or rotating the client:
 *
 *   npm run build && node tools/bake-oauth.js <client-id>
 *   node tools/bake-oauth.js            # prompts for the ID
 *
 * The client ID of a desktop OAuth client is a public identifier (Google
 * renders it inside every consent URL it serves), so the XOR split is
 * obfuscation — it keeps plaintext Google identifiers out of the repository
 * and the installer's unpacked resources — not encryption. PKCE is what
 * actually authenticates the app; no client secret is stored anywhere.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

async function readId(): Promise<string> {
  if (process.argv[2]) return process.argv[2].trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question('OAuth client ID: ', resolve));
  rl.close();
  return answer.trim();
}

async function main(): Promise<void> {
  const id = await readId();
  if (!/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(id)) {
    console.error('That does not look like an OAuth client ID (should end with ".apps.googleusercontent.com").');
    process.exit(1);
  }
  const key = crypto.randomBytes(32);
  const data = Buffer.from(id.split('').map((c, i) => c.charCodeAt(0) ^ key[i % key.length])).toString('base64');
  const mainTs = path.join(__dirname, '..', 'main.ts');
  let src = fs.readFileSync(mainTs, 'utf8');
  const before = src;
  src = src.replace(/const OAUTH_ID_KEY = '[^']*';/, `const OAUTH_ID_KEY = '${key.toString('base64')}';`);
  src = src.replace(/const OAUTH_ID_DATA = '[^']*';/, `const OAUTH_ID_DATA = '${data}';`);
  if (src === before) {
    console.error('Could not find the OAUTH_ID_KEY/OAUTH_ID_DATA constants in main.ts — was that section renamed?');
    process.exit(1);
  }
  fs.writeFileSync(mainTs, src);
  console.log('main.ts updated with the new encoded client ID. Run: npm run build');
}

void main();
