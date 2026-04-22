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
      t.includes('cancellation') || t.includes('result') ||
      t.includes('registration') || t.includes('portal') ||
      t.includes('timetable') || t.includes('academic'))        return 'academic';
  if (t.includes('event') || t.includes('dialogue') ||
      t.includes('ceremony') || t.includes('matriculation') ||
      t.includes('graduation') || t.includes('convene'))        return 'event';
  return 'academic';
}

// Fetch body text AND image from individual announcement page
async function fetchPageDetails(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    // ── Image — grab the featured image src ──────────────────────────────────
    // UPSA pages have an <img> right at the top of the post content
    let image_url = '';
    const featuredImg = $('.jeg_featured img, .post-image img, article img, .entry-content img').first();
    if (featuredImg.length) {
      image_url = featuredImg.attr('src') || featuredImg.attr('data-src') || '';
    }
    // Fallback — grab first img inside the article that isn't the logo
    if (!image_url) {
      $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src && !src.includes('upsa-logo') && !src.includes('avatar') && src.startsWith('http')) {
          image_url = src;
          return false; // break
        }
      });
    }

    // ── Body text ─────────────────────────────────────────────────────────────
    // Remove nav, header, footer, scripts before extracting text
    $('nav, header, footer, script, style, .jeg_header, .jeg_footer, .jeg_navigation').remove();

    // Try common WordPress content selectors
    let body = '';
    const selectors = ['.entry-content', '.jeg_post_content', '.post-content', 'article .content', '.single-content'];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        body = cleanText(el.text());
        if (body.length > 50) break;
      }
    }

    // Fallback — grab paragraphs inside article
    if (!body || body.length < 50) {
      const paragraphs = [];
      $('article p, .post p').each((i, el) => {
        const txt = cleanText($(el).text());
        if (txt.length > 20) paragraphs.push(txt);
      });
      body = paragraphs.join(' ');
    }

    // Cap at 500 chars for the preview
    if (body.length > 500) body = body.slice(0, 500) + '…';

    return { body, image_url };
  } catch {
    return { body: '', image_url: '' };
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrape() {
  console.log('🔍 Fetching UPSA announcements page...');
  const { data } = await axios.get(ANNOUNCEMENTS_URL, { timeout: 15000 });
  const $ = cheerio.load(data);

  const announcements = [];

  $('h3 a').each((i, el) => {
    const title = cleanText($(el).text());
    const link  = $(el).attr('href') || '';
    if (!title || !link) return;
    if (!link.startsWith('https://upsa.edu.gh')) return;
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
  let updated = 0;

  for (const a of announcements) {
    const slug = a.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');
    const ref = db.collection('announcements').doc(slug);

    const existing = await ref.get();

    if (existing.exists) {
      // If body is empty on existing doc, try to fill it in
      const existingData = existing.data();
      if (!existingData.body || existingData.body.length < 10) {
        console.log(`🔄 Updating body for: ${a.title.slice(0, 50)}...`);
        const { body, image_url } = await fetchPageDetails(a.link);
        await ref.update({ body, image_url });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    // New announcement — fetch full details
    console.log(`📄 Fetching details for: ${a.title.slice(0, 50)}...`);
    const { body, image_url } = await fetchPageDetails(a.link);

    await ref.set({
      title:           a.title,
      body:            body,
      image_url:       image_url,
      category:        detectCategory(a.title),
      target_audience: 'all',
      source_url:      a.link,
      is_active:       true,
      created_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`✅ Added: ${a.title.slice(0, 60)}`);
    console.log(`   📷 Image: ${image_url ? 'found' : 'none'}`);
    console.log(`   📝 Body: ${body ? body.slice(0, 60) + '...' : 'empty'}`);

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n🎉 Done — ${added} added, ${updated} updated, ${skipped} already complete`);
}

pushToFirebase().catch(err => {
  console.error('❌ Scraper failed:', err.message);
  process.exit(1);
});
