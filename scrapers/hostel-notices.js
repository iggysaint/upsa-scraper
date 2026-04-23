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
const ANNOUNCEMENTS_URL = 'https://upsa.edu.gh/announcements/';

// Keywords that flag a post as hostel-related
const HOSTEL_KEYWORDS = [
  'hostel', 'accommodation', 'room', 'hms', 'residential',
  'hall', 'bed', 'booking', 'apply for room', 'room allocation',
  'check-in', 'check in', 'eviction', 'vacate',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isHostelRelated(title, body = '') {
  const combined = (title + ' ' + body).toLowerCase();
  return HOSTEL_KEYWORDS.some(kw => combined.includes(kw));
}

async function fetchPageDetails(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    let image_url = '';
    const featuredImg = $('.jeg_featured img, .post-image img, article img, .entry-content img').first();
    if (featuredImg.length) {
      image_url = featuredImg.attr('src') || featuredImg.attr('data-src') || '';
    }
    if (!image_url) {
      $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src && !src.includes('upsa-logo') && !src.includes('avatar') && src.startsWith('http')) {
          image_url = src;
          return false;
        }
      });
    }

    $('nav, header, footer, script, style, .jeg_header, .jeg_footer, .jeg_navigation').remove();

    let body = '';
    const selectors = ['.entry-content', '.jeg_post_content', '.post-content', 'article .content', '.single-content'];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        body = cleanText(el.text());
        if (body.length > 50) break;
      }
    }

    if (!body || body.length < 50) {
      const paragraphs = [];
      $('article p, .post p').each((i, el) => {
        const txt = cleanText($(el).text());
        if (txt.length > 20) paragraphs.push(txt);
      });
      body = paragraphs.join(' ');
    }

    if (body.length > 800) body = body.slice(0, 800) + '…';

    return { body, image_url };
  } catch {
    return { body: '', image_url: '' };
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrape() {
  console.log('🏠 Fetching UPSA announcements for hostel notices...');
  const { data } = await axios.get(ANNOUNCEMENTS_URL, { timeout: 15000 });
  const $ = cheerio.load(data);

  const items = [];
  $('h3 a').each((i, el) => {
    const title = cleanText($(el).text());
    const link  = $(el).attr('href') || '';
    if (!title || !link) return;
    if (!link.startsWith('https://upsa.edu.gh')) return;
    items.push({ title, link });
  });

  // Filter to hostel-related posts by title first (fast)
  const hostelItems = items.filter(a => isHostelRelated(a.title));
  console.log(`📋 Found ${items.length} total, ${hostelItems.length} hostel-related`);
  return hostelItems;
}

// ── Push to Firebase ──────────────────────────────────────────────────────────
async function pushToFirebase() {
  const hostelItems = await scrape();

  if (!hostelItems.length) {
    console.log('ℹ️  No hostel-related announcements found this run');
    return;
  }

  let added = 0, skipped = 0, updated = 0;

  for (const a of hostelItems) {
    const slug = a.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');

    const ref = db.collection('hostel_notices').doc(slug);
    const existing = await ref.get();

    if (existing.exists) {
      const existingData = existing.data();
      if (!existingData.body || existingData.body.length < 10) {
        console.log(`🔄 Updating body for: ${a.title.slice(0, 50)}...`);
        const { body, image_url } = await fetchPageDetails(a.link);
        // Also re-check if body confirms hostel relevance
        if (!isHostelRelated(a.title, body)) { skipped++; continue; }
        await ref.update({ body, image_url });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    console.log(`📄 Fetching details for: ${a.title.slice(0, 50)}...`);
    const { body, image_url } = await fetchPageDetails(a.link);

    // Final check — confirm body also has hostel content
    if (!isHostelRelated(a.title, body)) {
      console.log(`   ⏭  Skipping (not hostel-related after body check): ${a.title.slice(0, 50)}`);
      skipped++;
      continue;
    }

    await ref.set({
      title:      a.title,
      body:       body,
      image_url:  image_url,
      source_url: a.link,
      is_active:  true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`✅ Added hostel notice: ${a.title.slice(0, 60)}`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n🎉 Done — ${added} added, ${updated} updated, ${skipped} skipped`);
}

pushToFirebase().catch(err => {
  console.error('❌ Hostel notices scraper failed:', err.message);
  process.exit(1);
});
