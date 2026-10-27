import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientBody } from '../oidc/register-extension-client.mjs';

test('extension client is public, PKCE-only and limited to chromiumapp.org redirects', () => {
  const body = buildClientBody(['https://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/']);
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.equal(body.type, 'user-agent-based');
  assert.equal(body.require_pkce, true);
  assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
  assert.equal(body.scope, 'openid profile email offline_access');
  for (const bad of ['https://evil.example/', 'https://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/cb?x=1', 'http://dljipjmfogkcfmbainbepkmblodkndph.chromiumapp.org/']) {
    assert.throws(() => buildClientBody([bad]));
  }
  assert.throws(() => buildClientBody([]));
});
