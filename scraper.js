import axios from 'axios';
import * as cheerio from 'cheerio';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────
const ANNOUNCEMENTS_URL = 'https://upsa.edu.gh/announcements/';

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function detectCategory(title) {
  const t = title.toLowerCase();
  if (t.includes('urgent') || t.includes('important'))          return 'urgent';
  if (t.includes('exam') || t.includes('reschedule') ||
      t.includes('cancellation') || t.includes('result'))       return 'academic';
  if (t.includes('event') || t.includes('dialogue') ||
      t.includes('ceremony') || t.includes('matriculation') ||
      t.includes('graduation') || t.includes('convene'))        return 'event';
  return 'academic'; // UPSA announcements are mostly academic
}

// Fetch full body text from individual announcement page
async function fetchBody(url) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const $ = cheerio.load(data);
    // UPSA post content lives in .entry-content or .jeg_main_content
    const content = $('.entry-content').first().text() ||
                    $('.jeg_main_content').first().text() || '';
    const cleaned = cleanText(content);
    // Return first 300 chars as body preview
    return cleaned.length > 300 ? cleaned.slice(0, 300) + '…' : cleaned;
  } catch {
    return ''; // silent — body is optional
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrape() {
  console.log('🔍 Fetching UPSA announcements page...');
  const { data } = await axios.get(ANNOUNCEMENTS_URL, { timeout: 15000 });
  const $ = cheerio.load(data);

  const announcements = [];

  // Each announcement is an <h3> with an <a> inside
  $('h3 a').each((i, el) => {
    const title = cleanText($(el).text());
    const link  = $(el).attr('href') || '';

    if (!title || !link) return;
    if (!link.startsWith('https://upsa.edu.gh')) return; // skip external links

    announcements.push({ title, link });
  });

  console.log(`📋 Found ${announcements.length} announcements`);
  return announcements;
}

// ── Push to Firebase ──────────────────────────────────────────────────────────
async function pushToFirebase() {
  const announcements = await scrape();

  if (!announcements.length) {
    console.log('⚠️  No announcements found — check selectors');
    return;
  }

  let added   = 0;
  let skipped = 0;

  for (const a of announcements) {
    // Use the URL slug as the document ID — guarantees no duplicates
    const slug = a.link.replace('https://upsa.edu.gh/', '').replace(/\/$/, '').replace(/\//g, '-');
    const ref  = db.collection('announcements').doc(slug);

    const existing = await ref.get();
    if (existing.exists) {
      skipped++;
      continue; // already in Firebase — don't overwrite
    }

    // Fetch full body for new announcements only
    console.log(`📄 Fetching body for: ${a.title.slice(0, 50)}...`);
    const body = await fetchBody(a.link);

    await ref.set({
      title:           a.title,
      body:            body,
      category:        detectCategory(a.title),
      target_audience: 'all',
      source_url:      a.link,
      is_active:       true,
      created_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`✅ Added: ${a.title.slice(0, 60)}`);

    // Small delay to avoid hammering UPSA server
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n🎉 Done — ${added} added, ${skipped} already existed`);
}

pushToFirebase().catch(err => {
  console.error('❌ Scraper failed:', err.message);
  process.exit(1);
});
