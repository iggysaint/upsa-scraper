// Usage:
//   node src/cli.js posts            announcements + news + opinions, hostel notices
//   node src/cli.js events
//   node src/cli.js fees
//   add --dry-run to see what would be sent; nothing is written. With
//   UNIFY_API_URL and SCRAPER_API_KEY set, the API also reports what it
//   would insert or update.
import { fetchEvents } from './sources/events.js';
import { announcementItems, feeItems, fetchPosts, hostelItems } from './sources/posts.js';
import { hasUnifySettings, reportFailure, sendBatch } from './unify.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const job = args.find((a) => !a.startsWith('--'));
const runId = process.env.GITHUB_RUN_ID ? `gh-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${new Date().toISOString()}`;

// Which UNIFY sources each job feeds, and how to collect their items.
const JOBS = {
  posts: { sources: ['announcements', 'hostel_notices'], collect: async () => {
    const posts = await fetchPosts();
    // The announcement listing is never really empty: zero posts means the
    // API changed, so report it rather than sending "nothing".
    if (posts.announcements.length === 0) throw new Error('parse_failed: no announcement posts returned');
    return { announcements: announcementItems(posts), hostel_notices: hostelItems(posts) };
  } },
  events: { sources: ['events'], collect: async () => ({ events: (await fetchEvents()).items }) },
  fees: { sources: ['fee_deadlines'], collect: async () => ({ fee_deadlines: feeItems(await fetchPosts()) }) },
};

function summarize(source, items) {
  console.log(`\n${source}: ${items.length} item(s)`);
  for (const i of items.slice(0, 50)) {
    console.log(`  - ${i.title.slice(0, 70)}${i.date ? ` [${i.date}]` : ''}  ${i.sourceUrl}`);
  }
}

async function main() {
  const spec = JOBS[job];
  if (!spec) {
    console.error(`Unknown job "${job ?? ''}". Use one of: ${Object.keys(JOBS).join(', ')}`);
    process.exit(2);
  }
  const started = Date.now();
  let collected;
  try {
    collected = await spec.collect();
  } catch (e) {
    const reason = String(e.message).startsWith('parse_failed') ? 'parse_failed' : 'fetch_failed';
    console.error(`✖ ${job}: ${reason}: ${e.message}`);
    if (!dryRun && hasUnifySettings()) {
      for (const s of spec.sources) await reportFailure(s, runId, reason).catch((err) => console.error(`  (could not report: ${err.message})`));
    }
    process.exit(1);
  }

  for (const source of spec.sources) {
    const items = collected[source];
    summarize(source, items);
    if (dryRun && !hasUnifySettings()) continue;
    const result = await sendBatch(source, runId, items, { dryRun });
    const c = result.counts;
    console.log(`  ${dryRun ? 'would be' : 'sent'}: ${c.inserted} new, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skippedStaff} kept (staff edited), ${c.duplicates} duplicate, ${c.rejected} rejected`);
    for (const r of result.rejected ?? []) console.log(`    rejected #${r.index}: ${r.reason}`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s${dryRun ? ' (dry run: nothing written)' : ''}.`);
}

main().catch((e) => {
  console.error(`✖ ${job}: ${e.message}`);
  process.exit(1);
});
