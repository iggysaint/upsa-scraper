// Fetching from the public UPSA website only (CLAUDE.md §6.2): allowlisted
// https hosts, bounded timeouts and retries, a clear user agent, and polite
// pauses between requests.
const ALLOWED_HOSTS = new Set(['upsa.edu.gh', 'www.upsa.edu.gh']);
const USER_AGENT = 'UNIFY-campus-app-scraper/2.0 (+https://github.com/iggysaint/upsa-scraper)';

export function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`Blocked URL outside upsa.edu.gh: ${u.origin}`);
  }
  return u;
}

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url, timeoutMs) {
  assertAllowed(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Redirects must stay on the UPSA site too.
  assertAllowed(res.url || url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Retries network errors and 5xx/429 (not other 4xx), with backoff.
export async function fetchWithRetry(url, { timeoutMs = 20_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(url, timeoutMs);
    } catch (e) {
      lastError = e;
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      if (!retryable || attempt === retries) break;
      await pause(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

export const fetchText = async (url, opts) => (await fetchWithRetry(url, opts)).text();
export const fetchJson = async (url, opts) => (await fetchWithRetry(url, opts)).json();
