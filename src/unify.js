// Sends scraped items to the UNIFY API (never to a database directly,
// CLAUDE.md §6.2). Settings come from environment variables:
//   UNIFY_API_URL    e.g. https://unify-api-hx7b.onrender.com
//   SCRAPER_API_KEY  the scraper's service key (a GitHub secret)
const TIMEOUT_MS = 90_000; // the free API server may need a minute to wake

function settings() {
  const url = process.env.UNIFY_API_URL?.replace(/\/+$/, '');
  const key = process.env.SCRAPER_API_KEY;
  if (!url || !key) throw new Error('UNIFY_API_URL and SCRAPER_API_KEY must be set');
  return { url, key };
}

async function post(path, body) {
  const { url, key } = settings();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UNIFY API ${res.status} on ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const hasUnifySettings = () => Boolean(process.env.UNIFY_API_URL && process.env.SCRAPER_API_KEY);

// One batch per source per run. dryRun: the API reports what it would do
// and writes nothing.
export const sendBatch = (source, runId, items, { dryRun = false } = {}) =>
  post('/ingest/v1/batches', { source, runId, items, dryRun });

// The source could not be fetched or parsed: nothing is sent or removed,
// and the admin "Website sync" card shows the problem.
export const reportFailure = (source, runId, reason) => post('/ingest/v1/failures', { source, runId, reason });
