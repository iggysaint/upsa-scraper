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

// ── Sources ───────────────────────────────────────────────────────────────────
const SOURCES = [
  {
    url: 'https://upsa.edu.gh/news/',
    category: 'articles',
  },
  {
    url: 'https://upsa.edu.gh/opinions/',
    category: 'articles',
  },
];

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Lowercase, letters/numbers/spaces only — used to compare headlines loosely
function norm(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Featured image extraction ─────────────────────────────────────────────────
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

    imageCandidates.push({ src, score: width * height });
  });

  if (imageCandidates.length) {
    imageCandidates.sort((a, b) => b.score - a.score);
    return imageCandidates[0].src;
  }

  return '';
}

// ── Body extraction ───────────────────────────────────────────────────────────
// Things that are never part of the article text.
const NOISE_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form',
  '.jeg_header', '.jeg_footer', '.jeg_navigation', '.jeg_sidebar', '.sidebar', '.widget',
  '.sharedaddy', '.jeg_share_button', '.jeg_share_top_container', '.jeg_share_bottom_container',
  '.jeg_authorbox', '.jnews_author_box_container', '.jnews_prev_next_container',
  '.comments-area', '#comments', '.post-navigation',
  '.wp-caption-text', 'figcaption',
].join(', ');

// "Related / latest news" style blocks. These are what was leaking other
// articles' headlines into the body.
const LISTING_LIKE_SELECTORS = '[class*="related"], [class*="jeg_postblock"]';

// Where the real post text lives
const CONTENT_SELECTORS =
  '.entry-content, .content-inner, .jeg_post_content, .post-content, .single-content';

// Tried in order, most specific first
const BODY_SELECTORS = [
  '.content-inner',
  '.entry-content',
  '.jeg_post_content',
  '.post-content',
  '.single-content',
  'article .content',
  'article',
  'main',
];

function stripNoise($) {
  $(NOISE_SELECTORS).remove();

  // Only drop related/latest blocks that do NOT wrap the real post content
  $(LISTING_LIKE_SELECTORS)
    .filter((_, el) => $(el).find(CONTENT_SELECTORS).length === 0)
    .remove();
}

// Text of the <p> tags inside an element. Headlines in widgets are usually
// h2/h3 links, not paragraphs, so this skips most listing junk on its own.
function paragraphText($, el) {
  return $(el)
    .find('p')
    .map((_, p) => cleanText($(p).text()))
    .get()
    .filter((txt) => txt.length > 20)
    .join(' ');
}

// True if the text opens with the headline of a DIFFERENT article
function startsWithOtherTitle(text, ownTitle, allTitles) {
  const head = norm(text.slice(0, 300));
  const own = norm(ownTitle);

  return allTitles.some((title) => {
    const other = norm(title);
    if (other.length < 20 || other === own) return false;
    if (other.slice(0, 40) === own.slice(0, 40)) return false;
    return head.includes(other.slice(0, 40));
  });
}

// ── Fetch page details ────────────────────────────────────────────────────────
async function fetchPageDetails(url, ownTitle, allTitles) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: REQUEST_HEADERS,
    });

    const $ = cheerio.load(data);

    // Grab image + meta description BEFORE stripping anything
    const image_url = getBestImage($);
    const metaDescription = cleanText(
      $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        ''
    );

    stripNoise($);

    let body = '';

    for (const selector of BODY_SELECTORS) {
      // Several elements can match: keep the one with the most paragraph text
      let best = '';

      $(selector).each((_, el) => {
        const text = paragraphText($, el);
        if (text.length > best.length) best = text;
      });

      if (best.length > 80 && !startsWithOtherTitle(best, ownTitle, allTitles)) {
        body = best;
        break;
      }
    }

    // Fallback: the page's own summary, if it isn't another article's headline
    if (
      !body &&
      metaDescription.length > 40 &&
      !startsWithOtherTitle(metaDescription, ownTitle, allTitles)
    ) {
      body = metaDescription;
    }

    if (body.length > 800) {
      body = body.slice(0, 800) + '…';
    }

    return { body, image_url };
  } catch (err) {
    console.log(`❌ Failed to fetch page details: ${url}`);

    return { body: '', image_url: '' };
  }
}

// ── Scrape a single source page ───────────────────────────────────────────────
async function scrapePage(source) {
  console.log(`🔍 Fetching ${source.category}: ${source.url}`);

  const { data } = await axios.get(source.url, {
    timeout: 15000,
    headers: REQUEST_HEADERS,
  });

  const $ = cheerio.load(data);

  const items = [];

  $('h3 a').each((_, el) => {
    const title = cleanText($(el).text());
    const link = $(el).attr('href') || '';

    if (!title || !link) return;
    if (!link.startsWith('https://upsa.edu.gh')) return;

    items.push({
      title,
      link,
      category: source.category,
    });
  });

  console.log(`📋 Found ${items.length} item(s)`);

  return items;
}

// ── Push to Firebase ──────────────────────────────────────────────────────────
async function pushToFirebase() {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  // 1. Collect every article link from all sources first
  const items = [];
  const seenLinks = new Set();

  for (const source of SOURCES) {
    try {
      const found = await scrapePage(source);

      for (const item of found) {
        if (seenLinks.has(item.link)) {
          skipped++; // same article listed twice
          continue;
        }
        seenLinks.add(item.link);
        items.push(item);
      }
    } catch (err) {
      console.error(`❌ Failed to scrape ${source.url}:`, err.message);
    }
  }

  // Every known headline, used to spot bodies that are really another article's title
  const allTitles = items.map((item) => item.title);

  // 2. Fetch each article and save it
  for (const item of items) {
    const slug = item.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');

    const ref = db.collection('announcements').doc(slug);

    const existing = await ref.get();

    console.log(`📄 Fetching: ${item.title.slice(0, 60)}...`);

    const { body, image_url } = await fetchPageDetails(
      item.link,
      item.title,
      allTitles
    );

    const payload = {
      title: item.title,
      body,
      image_url,
      category: item.category,
      target_audience: 'all',
      source_url: item.link,
      is_active: true,
    };

    if (existing.exists) {
      // Overwrites the old (possibly wrong) body with the fresh one
      await ref.update(payload);
      updated++;
      console.log(`🔄 Updated: ${item.title.slice(0, 60)}`);
    } else {
      await ref.set({
        ...payload,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      added++;
      console.log(`✅ Added: ${item.title.slice(0, 60)}`);
    }

    console.log(`   📷 ${image_url || 'none'}`);
    console.log(`   📝 ${body ? body.slice(0, 90) : 'no body found'}`);

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `\n🎉 Done — ${added} added, ${updated} updated, ${skipped} skipped`
  );
}

pushToFirebase().catch((err) => {
  console.error('❌ News/opinions scraper failed:', err.message);

  process.exit(1);
});