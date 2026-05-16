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

// ── Sources ───────────────────────────────────────────────────────────────────
const SOURCES = [
  { url: 'https://upsa.edu.gh/news/',     category: 'news'     },
  { url: 'https://upsa.edu.gh/opinions/', category: 'opinions' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ── Fetch body + image from individual article page ───────────────────────────
async function fetchPageDetails(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);

    // ── Image — og:image is always the correct featured image on UPSA pages ──
    let image_url = $('meta[property="og:image"]').attr('content') || '';

    // Fallback — twitter:image
    if (!image_url) {
      image_url = $('meta[name="twitter:image"]').attr('content') || '';
    }

    // Fallback — WordPress featured image classes
    if (!image_url) {
      const featuredImg = $('.jeg_featured img, .post-thumbnail img, .wp-post-image').first();
      if (featuredImg.length) {
        image_url = featuredImg.attr('src') || featuredImg.attr('data-src') || '';
      }
    }

    // Last resort — first wp-content/uploads image that isn't a logo/icon
    if (!image_url) {
      $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (
          src &&
          src.includes('/wp-content/uploads/') &&
          !src.includes('logo') &&
          !src.includes('avatar') &&
          !src.includes('icon') &&
          !src.includes('cropped') &&
          src.startsWith('http')
        ) {
          image_url = src;
          return false; // break
        }
      });
    }

    // ── Body text ─────────────────────────────────────────────────────────────
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

// ── Scrape a single source page ───────────────────────────────────────────────
async function scrapePage(source) {
  console.log(`\n🔍 Fetching ${source.category} page: ${source.url}`);
  const { data } = await axios.get(source.url, { timeout: 15000 });
  const $ = cheerio.load(data);

  const items = [];
  $('h3 a').each((i, el) => {
    const title = cleanText($(el).text());
    const link  = $(el).attr('href') || '';
    if (!title || !link) return;
    if (!link.startsWith('https://upsa.edu.gh')) return;
    items.push({ title, link, category: source.category });
  });

  console.log(`   📋 Found ${items.length} item(s)`);
  return items;
}

// ── Push to Firebase ──────────────────────────────────────────────────────────
async function pushToFirebase() {
  let totalAdded = 0, totalSkipped = 0, totalUpdated = 0;

  for (const source of SOURCES) {
    let items;
    try {
      items = await scrapePage(source);
    } catch (err) {
      console.error(`   ❌ Failed to scrape ${source.url}: ${err.message}`);
      continue;
    }

    for (const item of items) {
      const slug = item.link
        .replace('https://upsa.edu.gh/', '')
        .replace(/\/$/, '')
        .replace(/\//g, '-');

      const ref      = db.collection('announcements').doc(slug);
      const existing = await ref.get();

      if (existing.exists) {
        const existingData = existing.data();
        if (!existingData.body || existingData.body.length < 10) {
          console.log(`🔄 Updating body for: ${item.title.slice(0, 50)}...`);
          const { body, image_url } = await fetchPageDetails(item.link);
          await ref.update({ body, image_url });
          totalUpdated++;
        } else {
          totalSkipped++;
        }
        continue;
      }

      console.log(`📄 Fetching details for: ${item.title.slice(0, 50)}...`);
      const { body, image_url } = await fetchPageDetails(item.link);

      await ref.set({
        title:           item.title,
        body:            body,
        image_url:       image_url,
        category:        item.category,
        target_audience: 'all',
        source_url:      item.link,
        is_active:       true,
        created_at:      admin.firestore.FieldValue.serverTimestamp(),
      });

      totalAdded++;
      console.log(`✅ Added [${item.category}]: ${item.title.slice(0, 60)}`);
      console.log(`   📷 Image: ${image_url ? 'found' : 'none'}`);
      console.log(`   📝 Body: ${body ? body.slice(0, 60) + '...' : 'empty'}`);

      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n🎉 Done — ${totalAdded} added, ${totalUpdated} updated, ${totalSkipped} already complete`);
}

pushToFirebase().catch(err => {
  console.error('❌ News/opinions scraper failed:', err.message);
  process.exit(1);
});