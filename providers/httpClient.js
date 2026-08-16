/**
 * Shared request/backoff/health logic used by every provider adapter.
 * One place that knows how to turn HTTP responses into: success, a transient
 * rate limit (backoff + retry), a quota exhaustion (stop for the run), or an
 * auth failure (stop for the run) - so adapters don't each reimplement this.
 */

const QUOTA_PATTERN = /limit reach|upgrade your plan|quota|daily limit|plan limit/i;

function createHttpClient({ name, pacingMs = 1000, maxAttempts = 1, treatAny429AsQuota = false, headers = {} }) {
  const health = { state: 'available', detail: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setHealth(state, detail) {
    health.state = state;
    health.detail = detail;
  }

  async function getJSON(url, label) {
    if (health.state === 'quota_exhausted' || health.state === 'auth_failed') {
      return { ok: false, reason: health.state };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(pacingMs);

      let res;
      try {
        res = await fetch(url, { headers });
      } catch (err) {
        if (attempt === maxAttempts) {
          console.warn('  ! ' + label + ': network error - ' + err.message);
          return { ok: false, reason: 'error' };
        }
        await sleep(3000);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        console.warn('  ! ' + label + ': HTTP ' + res.status + ' (auth) - disabling ' + name + ' for this run');
        setHealth('auth_failed', 'HTTP ' + res.status);
        return { ok: false, reason: 'auth_failed' };
      }

      if (res.status === 429) {
        const bodyText = await res.text().catch(() => '');
        const isQuota = treatAny429AsQuota || QUOTA_PATTERN.test(bodyText);

        if (isQuota) {
          const detail = QUOTA_PATTERN.test(bodyText) ? bodyText.trim() : 'no burst signal - treating as daily quota';
          console.warn('  ! ' + label + ': HTTP 429 (' + detail + ') - disabling ' + name + ' for the rest of this run');
          setHealth('quota_exhausted', detail);
          return { ok: false, reason: 'quota_exhausted' };
        }

        if (attempt === maxAttempts) {
          console.warn('  ! ' + label + ': HTTP 429 - rate limited, giving up for this call');
          return { ok: false, reason: 'rate_limited' };
        }

        setHealth('rate_limited', 'HTTP 429 (transient)');
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 15000) : 5000;
        console.warn('  ! ' + label + ': HTTP 429 - rate limited, retrying in ' + Math.round(waitMs / 1000) + 's');
        await sleep(waitMs);
        setHealth('available', null); // transient - clears once we retry
        continue;
      }

      if (!res.ok) {
        console.warn('  ! ' + label + ': HTTP ' + res.status);
        return { ok: false, reason: 'error' };
      }

      try {
        return { ok: true, data: await res.json() };
      } catch (err) {
        console.warn('  ! ' + label + ': bad JSON - ' + err.message);
        return { ok: false, reason: 'error' };
      }
    }
    return { ok: false, reason: 'error' };
  }

  return { name, health, getJSON };
}

module.exports = { createHttpClient };
