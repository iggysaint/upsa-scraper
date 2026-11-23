# UPSA scraper for UNIFY

Brings public content from [upsa.edu.gh](https://upsa.edu.gh) into the UNIFY
campus app. It never writes to a database: it sends batches to the UNIFY API,
which owns every write and keeps staff edits safe.

| Job | What it reads | Sends to UNIFY as | Schedule (UTC = Ghana time) |
| --- | --- | --- | --- |
| `posts` | WordPress API: announcements, news, opinions (20 latest each) | announcements (published); hostel notices (title mentions hostel, accommodation…) | every hour at :17 |
| `events` | `/events/` page + each upcoming, happening or recent (30 days) event page | events (published) | every 6 hours at :41 |
| `fees` | WordPress API: announcements whose title is about fees or payment | fee deadlines as **drafts**; staff check and publish them in the UNIFY admin | daily at 06:23 |

Rules (owner decisions, 2026-11-23, recorded in the UNIFY repo's
`docs/decisions.md`):

- Staff edits win: once an admin edits or hides an item in UNIFY, the scraper
  never changes or re-shows it.
- Nothing is removed because it's missing from a run. Past events drop off by
  date.
- A page that can't be fetched or read is reported as a failure (the UNIFY
  admin "Website sync" card turns red); it never counts as "no news".

## Setup

1. Node 22. `npm ci`
2. Repository settings → Secrets and variables → Actions:
   - **Secret** `SCRAPER_API_KEY`: the same value as `SCRAPER_API_KEY` on the
     UNIFY API server (Render). Generate with `openssl rand -hex 32`.
   - **Variable** `UNIFY_API_URL`: e.g. `https://unify-api-hx7b.onrender.com`

## Running by hand

```bash
npm run dry-run:posts     # list what would be sent; writes nothing
npm run dry-run:events
npm run dry-run:fees
npm test                  # parser tests against saved UPSA pages
```

With `UNIFY_API_URL` and `SCRAPER_API_KEY` set, a dry run also asks the API
what it *would* insert or update (still writing nothing). In GitHub: Actions →
pick a sync workflow → Run workflow → tick "Dry run".

## Notes

- Only `https://upsa.edu.gh` (and `www.`) is fetched; redirects elsewhere are
  refused. Requests have timeouts, a couple of retries and short pauses.
  `robots.txt` on upsa.edu.gh was empty when checked (2026-11-23).
- Test fixtures in `test/fixtures` are real UPSA pages saved on 2026-11-23,
  trimmed. Refresh them when the site layout changes and a parser test fails.
- Retired with the move to UNIFY: Firebase writes, the weekly random club
  spotlight (admins choose featured clubs), fee push reminders (waiting for
  push notifications) and the exam seed script (exams are an admin task).
  They remain in git history.
