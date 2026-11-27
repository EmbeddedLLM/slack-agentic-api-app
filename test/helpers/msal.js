// No Microsoft connections or real tokens in tests. Exercise our real cache plugin.
export const tenantId = '11111111-1111-1111-1111-111111111111';
export const clientId = '22222222-2222-2222-2222-222222222222';
export const authResult = { accessToken: 'test-microsoft-access-token', tenantId,
  scopes: ['https://graph.microsoft.com/OnlineMeetings.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite'],
  account: { homeAccountId: 'test-organizer', username: 'organizer@example.test' } };

export function fakeMsal(result = authResult) {
  return class {
    constructor(options) {
      this.plugin = options.cache.cachePlugin;
      this.state = {};
      this.cache = { serialize: () => JSON.stringify(this.state), deserialize: text => { this.state = JSON.parse(text); },
        getAllAccounts: async () => { await this.plugin.beforeCacheAccess({ tokenCache: this.cache }); return this.state.accounts || []; } };
    }
    getTokenCache() { return this.cache; }
    async acquireTokenByDeviceCode({ deviceCodeCallback }) {
      deviceCodeCallback({ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'TESTCODE' });
      if (globalThis.__msalDeviceLogin) await globalThis.__msalDeviceLogin();
      await this.plugin.beforeCacheAccess({ tokenCache: this.cache });
      this.state = { accounts: [result.account], secret: result.accessToken };
      await this.plugin.afterCacheAccess({ tokenCache: this.cache, cacheHasChanged: true });
      return result;
    }
    async acquireTokenSilent({ account }) {
      if (account.homeAccountId !== result.account.homeAccountId) throw new Error('wrong account');
      await this.plugin.afterCacheAccess({ tokenCache: this.cache, cacheHasChanged: true });
      return result;
    }
  };
}
