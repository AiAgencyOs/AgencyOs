import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// The pure half of the AWS cron Lambda. Importing the module does NOT pull in the
// AWS SDK (it is dynamically imported only inside the runtime path), so this runs
// with no AWS and no network — exactly what a unit test of the request shape needs.
import { buildTickRequest } from '../infra/aws/cron/handler.mjs';

describe('the cron Lambda builds one authenticated tick request', () => {
  const full = {
    PROD_URL: 'https://agency-os.example.com',
    CRON_SECRET: 'cs-secret-value',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-token-value',
  };

  test('it POSTs the job runner path', () => {
    const req = buildTickRequest(full);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, 'https://agency-os.example.com/api/jobs/run');
  });

  test('it carries BOTH doors — the CRON_SECRET bearer and the Vercel bypass header', () => {
    const req = buildTickRequest(full);
    assert.equal(req.headers.Authorization, 'Bearer cs-secret-value');
    assert.equal(req.headers['x-vercel-protection-bypass'], 'bypass-token-value');
  });

  test('a trailing slash on PROD_URL does not double the path', () => {
    const req = buildTickRequest({ ...full, PROD_URL: 'https://agency-os.example.com/' });
    assert.equal(req.url, 'https://agency-os.example.com/api/jobs/run');
  });

  test('without a bypass token the header is omitted — an unprotected deployment needs none', () => {
    const req = buildTickRequest({ PROD_URL: full.PROD_URL, CRON_SECRET: full.CRON_SECRET });
    assert.equal(req.headers.Authorization, 'Bearer cs-secret-value');
    assert.ok(!('x-vercel-protection-bypass' in req.headers));
  });

  test('a tick with no PROD_URL cannot be built — it throws rather than POST nowhere', () => {
    assert.throws(() => buildTickRequest({ CRON_SECRET: 'x' }), /PROD_URL is not set/);
    assert.throws(() => buildTickRequest({ PROD_URL: '', CRON_SECRET: 'x' }), /PROD_URL is not set/);
  });

  test('a tick with no CRON_SECRET cannot be built — it would be refused 401 anyway', () => {
    assert.throws(() => buildTickRequest({ PROD_URL: full.PROD_URL }), /CRON_SECRET is not set/);
  });

  test('the secret value is never mangled — the bearer is the exact configured string', () => {
    const weird = 'a b/c+d=%e&f';
    const req = buildTickRequest({ ...full, CRON_SECRET: weird });
    assert.equal(req.headers.Authorization, `Bearer ${weird}`);
  });
});
