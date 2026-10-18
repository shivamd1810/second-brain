// Gmail via the Gmail REST API with the gmail.readonly scope only.
// You supply your own OAuth "Desktop app" client (credentials.json); `second-brain gmail-auth`
// runs the browser consent once and stores a refresh token next to it (chmod 600).
// Each run asks Gmail for messages after the newest one already indexed.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { dataDir } from '../config.ts';
import type { RecordInput } from '../db.ts';
import type { Connector, ConnectorContext, ConnectorResult } from './types.ts';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 8000;
const MAX_LIST = 5000;

export function gmailDir(): string {
  return path.join(dataDir(), 'gmail');
}

interface ClientSecrets {
  client_id: string;
  client_secret: string;
  auth_uri?: string;
  token_uri?: string;
}

interface Token {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

function readClient(): ClientSecrets {
  const file = path.join(gmailDir(), 'credentials.json');
  if (!fs.existsSync(file))
    throw new Error(`missing ${file}. Download your OAuth "Desktop app" client JSON from Google Cloud and save it there (see README → Gmail).`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error(`${file} does not look like an OAuth client file`);
  return c;
}

function tokenFile(): string {
  return path.join(gmailDir(), 'token.json');
}

function saveToken(t: Token): void {
  fs.mkdirSync(gmailDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function tokenRequest(client: ClientSecrets, params: Record<string, string>): Promise<Token> {
  const res = await fetch(client.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google token error: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  return {
    access_token: String(body.access_token),
    refresh_token: body.refresh_token ? String(body.refresh_token) : undefined,
    expires_at: Date.now() + Number(body.expires_in ?? 3600) * 1000 - 60_000,
    scope: body.scope ? String(body.scope) : undefined,
  };
}

async function accessToken(): Promise<string> {
  if (!fs.existsSync(tokenFile())) throw new Error('Gmail is not authorized yet. Run: second-brain gmail-auth');
  const t = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as Token;
  if (t.scope && t.scope.split(' ').some((s) => s !== GMAIL_SCOPE))
    throw new Error(`token has scopes beyond gmail.readonly (${t.scope}); delete ${tokenFile()} and re-run gmail-auth`);
  if (t.expires_at > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new Error('Gmail token expired and has no refresh token. Run: second-brain gmail-auth');
  try {
    const fresh = await tokenRequest(readClient(), { grant_type: 'refresh_token', refresh_token: t.refresh_token });
    saveToken({ ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token });
    return fresh.access_token;
  } catch (e) {
    throw new Error(`Gmail refresh failed (${(e as Error).message}). Password change or revoked access? Run: second-brain gmail-auth`);
  }
}

/** One-time browser consent. Loopback redirect + PKCE, as Google recommends for desktop apps. */
export async function gmailAuth(log: (m: string) => void): Promise<void> {
  const client = readClient();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const stateParam = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}`;
  const url = new URL(client.auth_uri ?? 'https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: stateParam,
  }).toString();
  log(`Opening your browser to grant READ-ONLY Gmail access.\nIf it does not open, visit:\n\n  ${url}\n`);
  if (process.platform === 'darwin') execFile('open', [url.toString()], () => {});
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for Google consent (5 min)')), 300_000);
    server.on('request', (req, res) => {
      const q = new URL(req.url ?? '/', redirect).searchParams;
      if (!q.get('code') && !q.get('error')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (q.get('state') !== stateParam || !q.get('code')) {
        res.end('Authorization failed. You can close this tab.');
        clearTimeout(timer);
        reject(new Error(`authorization failed: ${q.get('error') ?? 'state mismatch'}`));
        return;
      }
      res.end('Second brain: Gmail read-only access granted. You can close this tab.');
      clearTimeout(timer);
      resolve(q.get('code')!);
    });
  }).finally(() => server.close());
  const token = await tokenRequest(client, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
  saveToken(token);
  log(`Saved token to ${tokenFile()} (scope: ${token.scope ?? GMAIL_SCOPE}).`);
}

async function api<T>(token: string, pathAndQuery: string): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('Gmail rejected the token (401). Run: second-brain gmail-auth');
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

function decode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function findPart(p: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!p) return undefined;
  if (p.mimeType === mime && p.body?.data && !p.filename) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** Drop quoted history ("On ... wrote:" and "> " lines) so each message is just what was new. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

export function messageText(m: GmailMessage): string {
  const plain = findPart(m.payload, 'text/plain');
  if (plain?.body?.data) return stripQuoted(decode(plain.body.data));
  const html = findPart(m.payload, 'text/html');
  if (html?.body?.data) return stripQuoted(htmlToText(decode(html.body.data)));
  return m.snippet ?? '';
}

export function header(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export function messageToRecord(m: GmailMessage): RecordInput {
  const subject = header(m, 'Subject') || '(no subject)';
  const from = header(m, 'From');
  const text = messageText(m);
  const body = [
    `From: ${from}`,
    `To: ${header(m, 'To')}`,
    header(m, 'Cc') ? `Cc: ${header(m, 'Cc')}` : '',
    `Date: ${header(m, 'Date')}`,
    `Subject: ${subject}`,
    m.labelIds?.length ? `Labels: ${m.labelIds.join(', ')}` : '',
    '',
    text.length > MAX_BODY ? text.slice(0, MAX_BODY) + ' […]' : text,
  ]
    .filter((l, i) => l || i >= 6)
    .join('\n');
  return {
    id: `gm-${m.id}`,
    source: 'gmail',
    title: `[email] ${subject} (from ${from.replace(/<.*>/, '').trim() || from})`,
    date: new Date(Number(m.internalDate)).toISOString(),
    uri: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
    body,
    meta: { messageId: m.id, threadId: m.threadId, from, labels: m.labelIds },
    priority: 1,
  };
}

interface State {
  /** internalDate (ms) of the newest message indexed. */
  lastInternalDate?: number;
}

export const gmailConnector: Connector = {
  name: 'gmail',
  describe: () => `Gmail (read-only), credentials in ${gmailDir()}`,
  enabled: (cfg) => cfg.connectors.gmail.enabled,
  async run(ctx: ConnectorContext): Promise<ConnectorResult> {
    const cfg = ctx.config.connectors.gmail;
    const state = ctx.brain.getState<State>('gmail', {});
    const token = await accessToken();
    const when = state.lastInternalDate
      ? `after:${Math.floor(state.lastInternalDate / 1000) - 60}`
      : `newer_than:${cfg.firstRunDays}d`;
    const q = `${when} ${cfg.query}`.trim();
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
        token,
        `/messages?maxResults=500&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`,
      );
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_LIST);
    // Gmail lists newest first. Index oldest first so a capped run never leaves a gap.
    const todo = ids.reverse().filter((id) => !ctx.brain.getRecord(`gm-${id}`)).slice(0, cfg.maxMessagesPerRun);
    let created = 0;
    let updated = 0;
    for (const id of todo) {
      const m = await api<GmailMessage>(token, `/messages/${id}?format=full`);
      const res = ctx.brain.upsertRecord(messageToRecord(m));
      if (res === 'new') created++;
      if (res === 'updated') updated++;
      const d = Number(m.internalDate);
      if (!state.lastInternalDate || d > state.lastInternalDate) state.lastInternalDate = d;
      ctx.brain.setState('gmail', state);
    }
    const left = ids.length - todo.length;
    return {
      new: created,
      updated,
      notes: [`query: ${q}`, ...(left > 0 && todo.length === cfg.maxMessagesPerRun ? [`more to fetch; next run continues`] : [])],
    };
  },
};
