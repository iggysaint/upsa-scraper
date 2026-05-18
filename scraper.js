
import axios from 'axios';
import * as cheerio from 'cheerio';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  readFileSync('./serviceAccountKey.json', 'utf8')
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────
const ANNOUNCEMENTS_URL = 'https://upsa.edu.gh/announcements/';

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function detectCategory(title) {
  const t = title.toLowerCase();

  if (t.includes('urgent') || t.includes('important')) {
    return 'urgent';
  }

  if (
    t.includes('exam') ||
    t.includes('reschedule') ||
    t.includes('cancellation') ||
    t.includes('result') ||
    t.includes('registration') ||
    t.includes('portal') ||
    t.includes('timetable') ||
    t.includes('academic')
  ) {
    return 'academic';
  }

  if (
    t.includes('event') ||
    t.includes('dialogue') ||
    t.includes('ceremony') ||
    t.includes('matriculation') ||
    t.includes('graduation') ||
    t.includes('convene')
  ) {
    return 'event';
  }

  return 'academic';
}

// ── Better featured image extraction ──────────────────────────────────────────
function getBestImage($) {
  // 1. Trust og:image first (UPSA usually sets correct featured image)
  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[property="og:image:url"]').attr('content');

  if (ogImage && ogImage.startsWith('http')) {
    return ogImage;
  }

  // 2. Twitter image fallback
  const twitterImage = $('meta[name="twitter:image"]').attr('content');

  if (twitterImage && twitterImage.startsWith('http')) {
    return twitterImage;
  }

  // 3. Strong featured image selectors
  const strongSelectors = [
    '.jeg_featured img',
    '.featured-image img',
    '.post-thumbnail img',
    '.wp-post-image',
    'article img.wp-post-image',
    '.jeg_thumb img',
    '.single-featured-image img',
  ];

  for (const selector of strongSelectors) {
    const img = $(selector).first();

    if (img.length) {
      const src =
        img.attr('src') ||
        img.attr('data-src') ||
        img.attr('data-lazy-src') ||
        '';

      if (
        src &&
        src.startsWith('http') &&
        !src.includes('logo') &&
        !src.includes('avatar') &&
        !src.includes('icon')
      ) {
        return src;
      }
    }
  }

  // 4. Smart fallback: choose largest real content image
  const imageCandidates = [];

  $('article img, .entry-content img, .jeg_post_content img').each((_, el) => {
    const src =
      $(el).attr('src') ||
      $(el).attr('data-src') ||
      $(el).attr('data-lazy-src') ||
      '';

    if (!src || !src.startsWith('http')) return;

    if (
      src.includes('logo') ||
      src.includes('avatar') ||
      src.includes('icon') ||
      src.includes('cropped') ||
      src.includes('placeholder') ||
      src.includes('gravatar')
    ) {
      return;
    }

    const width = parseInt($(el).attr('width') || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);
    const score = width * height;

    imageCandidates.push({
      src,
      score,
    });
  });

  if (imageCandidates.length) {
    imageCandidates.sort((a, b) => b.score - a.score);
    return imageCandidates[0].src;
  }

  return '';
}

// ── Fetch page details ────────────────────────────────────────────────────────
async function fetchPageDetails(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const $ = cheerio.load(data);

    const image_url = getBestImage($);

    // Remove junk before body extraction
    $(
      'nav, header, footer, script, style, .jeg_header, .jeg_footer, .jeg_navigation, .sharedaddy, .sidebar'
    ).remove();

    let body = '';

    const selectors = [
      '.entry-content',
      '.jeg_post_content',
      '.post-content',
      'article .content',
      '.single-content',
      'article',
    ];

    for (const selector of selectors) {
      const el = $(selector).first();

      if (el.length) {
        body = cleanText(el.text());

        if (body.length > 80) {
          break;
        }
      }
    }

    // Paragraph fallback
    if (!body || body.length < 80) {
      const paragraphs = [];

      $('article p, .post p, .entry-content p').each((_, el) => {
        const txt = cleanText($(el).text());

        if (txt.length > 20) {
          paragraphs.push(txt);
        }
      });

      body = paragraphs.join(' ');
    }

    if (body.length > 800) {
      body = body.slice(0, 800) + '…';
    }

    return {
      body,
      image_url,
    };
  } catch (err) {
    console.log(`❌ Failed to fetch page details: ${url}`);

    return {
      body: '',
      image_url: '',
    };
  }
}

// ── Scrape announcements page ────────────────────────────────────────────────
async function scrape() {
  console.log('🔍 Fetching UPSA announcements page...');

  const { data } = await axios.get(ANNOUNCEMENTS_URL, {
    timeout: 15000,
  });

  const $ = cheerio.load(data);

  const announcements = [];

  $('h3 a').each((_, el) => {
    const title = cleanText($(el).text());
    const link = $(el).attr('href') || '';

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
    console.log('⚠️ No announcements found');
    return;
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of announcements) {
    const slug = item.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');

    const ref = db.collection('announcements').doc(slug);
    const existing = await ref.get();

    console.log(`📄 Fetching: ${item.title.slice(0, 60)}...`);

    const { body, image_url } = await fetchPageDetails(item.link);

    const payload = {
      title: item.title,
      body,
      image_url,
      category: detectCategory(item.title),
      target_audience: 'all',
      source_url: item.link,
      is_active: true,
    };

    if (existing.exists) {
      await ref.update(payload);
      updated++;

      console.log(`🔄 Updated: ${item.title.slice(0, 60)}`);
      console.log(`   📷 ${image_url || 'none'}`);
    } else {
      await ref.set({
        ...payload,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      added++;

      console.log(`✅ Added: ${item.title.slice(0, 60)}`);
      console.log(`   📷 ${image_url || 'none'}`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `\n🎉 Done — ${added} added, ${updated} updated, ${skipped} skipped`
  );
}

pushToFirebase().catch((err) => {
  console.error('❌ Scraper failed:', err.message);
  process.exit(1);
});