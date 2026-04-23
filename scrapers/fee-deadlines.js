import axios from 'axios';
import * as cheerio from 'cheerio';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────
// UPSA academic calendar and fees schedule pages
const PAGES_TO_SCRAPE = [
  'https://upsa.edu.gh/academics/academic-affairs/academic-calendar/',
  'https://upsa.edu.gh/academics/fees-schedule/',
  'https://upsa.edu.gh/announcements/',
];

// Keywords that flag something as a fee deadline
const FEE_KEYWORDS = [
  'fee', 'fees', 'payment', 'pay', 'deadline', 'financial clearance',
  'school fees', 'tuition', 'semester fees', 'portal fees',
  'ufis', 'interpay', 'clearance', 'fee payment',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isFeeRelated(text) {
  const t = text.toLowerCase();
  return FEE_KEYWORDS.some(kw => t.includes(kw));
}

// Try to parse a date string from messy text
function parseDeadlineDate(text) {
  // Match patterns like "31st January", "January 31", "31/01/2026", "2026-01-31"
  const patterns = [
    /(\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4})/gi,
    /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gi,
    /\d{1,2}\/\d{1,2}\/\d{4}/g,
    /\d{4}-\d{2}-\d{2}/g,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = new Date(match[0].replace(/(\d+)(st|nd|rd|th)/, '$1'));
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= new Date().getFullYear()) {
        return parsed;
      }
    }
  }
  return null;
}

async function scrapePage(url) {
  try {
    console.log(`🔍 Scraping: ${url}`);
    const { data } = await axios.get(url, { timeout: 15000 });
    const $ = cheerio.load(data);

    $('nav, header, footer, script, style, .jeg_header, .jeg_footer, .jeg_navigation').remove();

    const deadlines = [];

    // Grab all text blocks — paragraphs, list items, table rows
    const textBlocks = [];
    $('p, li, td, h2, h3, h4').each((i, el) => {
      const text = cleanText($(el).text());
      if (text.length > 10) textBlocks.push(text);
    });

    for (const block of textBlocks) {
      if (!isFeeRelated(block)) continue;

      const date = parseDeadlineDate(block);
      // Only include future or current-year deadlines
      if (date && date > new Date(new Date().setMonth(new Date().getMonth() - 1))) {
        deadlines.push({
          title:      block.length > 120 ? block.slice(0, 120) + '…' : block,
          date,
          source_url: url,
        });
      }
    }

    // Also check for announcement links that mention fees
    if (url.includes('announcements')) {
      $('h3 a').each((i, el) => {
        const title = cleanText($(el).text());
        const link  = $(el).attr('href') || '';
        if (isFeeRelated(title) && link.startsWith('https://upsa.edu.gh')) {
          deadlines.push({
            title,
            date:       null,
            source_url: link,
            is_link:    true,
          });
        }
      });
    }

    console.log(`   Found ${deadlines.length} potential fee deadline(s)`);
    return deadlines;
  } catch (err) {
    console.error(`   ❌ Failed to scrape ${url}: ${err.message}`);
    return [];
  }
}

// ── Push to Firebase ──────────────────────────────────────────────────────────
async function pushToFirebase() {
  const allDeadlines = [];

  for (const url of PAGES_TO_SCRAPE) {
    const found = await scrapePage(url);
    allDeadlines.push(...found);
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!allDeadlines.length) {
    console.log('ℹ️  No fee deadlines found this run');
    return;
  }

  let added = 0, skipped = 0;

  for (const deadline of allDeadlines) {
    // Use title as the doc ID (slugified)
    const slug = deadline.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);

    const ref = db.collection('fee_deadlines').doc(slug);
    const existing = await ref.get();

    if (existing.exists) {
      skipped++;
      continue;
    }

    await ref.set({
      title:      deadline.title,
      date:       deadline.date ? admin.firestore.Timestamp.fromDate(deadline.date) : null,
      source_url: deadline.source_url,
      is_active:  true,
      is_link:    deadline.is_link || false,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`✅ Added fee deadline: ${deadline.title.slice(0, 60)}`);
    console.log(`   📅 Date: ${deadline.date ? deadline.date.toDateString() : 'no date parsed'}`);
  }

  console.log(`\n🎉 Done — ${added} added, ${skipped} already existed`);
}

pushToFirebase().catch(err => {
  console.error('❌ Fee deadlines scraper failed:', err.message);
  process.exit(1);
});
