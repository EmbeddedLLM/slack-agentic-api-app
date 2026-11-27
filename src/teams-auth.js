import { PublicClientApplication } from '@azure/msal-node';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicJSON, readJSON } from './agentic-client.js';

export const teamsScopes = ['https://graph.microsoft.com/OnlineMeetings.ReadWrite'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const signInMessage = 'Teams organizer sign-in is unavailable or expired. An admin must run npm run teams:login on the bot host.';

// Bound each MSAL HTTP exchange too, including refresh-token POSTs. OAuth logic,
// device-code polling, authority validation and token refresh remain in MSAL.
async function authRequest(url, method, options = {}) {
  const response = await fetch(url, { method, headers: options.headers, ...(method === 'POST' ? { body: options.body } : {}),
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  return { headers: Object.fromEntries(response.headers), status: response.status, body: await response.json() };
}

export function teamsConfig(env = process.env) {
  return {
    enabled: /^(true|1|yes|on)$/i.test(env.TEAMS_ENABLED || ''),
    tenantId: (env.TEAMS_TENANT_ID || '').trim().toLowerCase(),
    clientId: (env.TEAMS_CLIENT_ID || '').trim().toLowerCase(),
    dir: path.resolve(env.TEAMS_STATE_DIR || 'data/teams'),
  };
}

// One bot process owns this cache. Stop it before using the login/logout CLI.
// MSAL owns OAuth and refresh tokens. Only the encrypted serialized cache is saved.
export class TeamsAuth {
  constructor(config = teamsConfig(), { createClient = options => new PublicClientApplication(options) } = {}) {
    this.config = config;
    this.createClient = createClient;
    this.queue = Promise.resolve();
  }
  file(name) { return path.join(this.config.dir, name); }
  validate() {
    if (!uuid.test(this.config.tenantId) || !uuid.test(this.config.clientId)) {
      throw new Error('Set TEAMS_TENANT_ID and TEAMS_CLIENT_ID to the Directory and Application UUIDs from Microsoft Entra → App registrations → Overview.');
    }
  }
  organizer() {
    this.validate();
    const saved = readJSON(this.file('organizer.json'));
    if (!saved?.homeAccountId || saved.tenantId !== this.config.tenantId || saved.clientId !== this.config.clientId) throw new Error(signInMessage);
    return saved;
  }
  ready() {
    if (!this.config.enabled) return false;
    try { return Boolean(this.organizer() && existsSync(this.file('cache.json')) && existsSync(this.file('cache.key'))); }
    catch { return false; }
  }
  async locked(fn) {
    const pending = this.queue.catch(() => {}).then(fn);
    this.queue = pending;
    return pending;
  }
  cachePlugin() {
    const key = readFileSync(this.file('cache.key'));
    if (key.length !== 32) throw new Error(signInMessage);
    return {
      beforeCacheAccess: async context => {
        const saved = readJSON(this.file('cache.json'));
        if (!saved) return;
        if (saved.version !== 1) throw new Error(signInMessage);
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
        const text = Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8');
        context.tokenCache.deserialize(text);
      },
      afterCacheAccess: async context => {
        if (!context.cacheHasChanged) return;
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const data = Buffer.concat([cipher.update(context.tokenCache.serialize(), 'utf8'), cipher.final()]);
        atomicJSON(this.file('cache.json'), { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
      },
    };
  }
  client() {
    return this.createClient({
      auth: { clientId: this.config.clientId, authority: `https://login.microsoftonline.com/${this.config.tenantId}` },
      cache: { cachePlugin: this.cachePlugin() },
      system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} }, networkClient: {
        sendGetRequestAsync: (url, options) => authRequest(url, 'GET', options),
        sendPostRequestAsync: (url, options) => authRequest(url, 'POST', options),
      } },
    });
  }
  checkResult(result, accountId) {
    const granted = result?.scopes?.some(scope => scope.toLowerCase().replace('https://graph.microsoft.com/', '') === 'onlinemeetings.readwrite');
    if (!result?.accessToken || !result.account?.homeAccountId || result.tenantId?.toLowerCase() !== this.config.tenantId || !granted ||
        (accountId && result.account.homeAccountId !== accountId)) throw new Error(signInMessage);
    return result;
  }
  async login(onCode) {
    this.validate();
    return this.locked(async () => {
      mkdirSync(this.config.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.config.dir, 0o700);
      if (!existsSync(this.file('cache.key'))) writeFileSync(this.file('cache.key'), randomBytes(32), { mode: 0o600, flag: 'wx' });
      chmodSync(this.file('cache.key'), 0o600);
      try {
        const result = this.checkResult(await this.client().acquireTokenByDeviceCode({ scopes: teamsScopes,
          deviceCodeCallback: response => onCode({ uri: response.verificationUri, code: response.userCode }) }));
        const organizer = { tenantId: this.config.tenantId, clientId: this.config.clientId, homeAccountId: result.account.homeAccountId,
          username: result.account.username, signedInAt: new Date().toISOString() };
        atomicJSON(this.file('organizer.json'), organizer);
        return organizer;
      } catch {
        throw new Error('Microsoft sign-in did not complete. Check the tenant/client IDs, public client flows, delegated OnlineMeetings.ReadWrite permission, and your organization’s consent/device-code policies, then retry.');
      }
    });
  }
  async token() {
    return this.locked(async () => {
      try {
        const organizer = this.organizer();
        const client = this.client();
        const accounts = await client.getTokenCache().getAllAccounts();
        const account = accounts.find(item => item.homeAccountId === organizer.homeAccountId);
        if (!account) throw new Error(signInMessage);
        const result = this.checkResult(await client.acquireTokenSilent({ account, scopes: teamsScopes }), organizer.homeAccountId);
        return { accessToken: result.accessToken, organizer };
      } catch { throw new Error(signInMessage); }
    });
  }
  logout() {
    for (const name of ['organizer.json', 'cache.json', 'cache.key']) rmSync(this.file(name), { force: true });
  }
}
