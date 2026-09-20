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
// An upsa.edu.gh article page is laid out like this:
//   <h1>Title</h1> · date · paragraphs · "Author" (h2) · "More Stories" (h2) + other headlines
// That "More Stories" block is what was leaking other articles' headlines into the body.
// Note: the page's og:description is cut off after ~10 words, so it is only a last resort.

const MAX_BODY_CHARS = 1800; // roughly 250-300 words
const MIN_GOOD_WORDS = 100;

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// Things that are never part of the article text.
const NOISE_SELECTORS = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'form',
  '.jeg_header', '.jeg_footer', '.jeg_navigation', '.jeg_sidebar', '.sidebar', '.widget',
  '.sharedaddy', '.jeg_share_button', '.jeg_share_top_container', '.jeg_share_bottom_container',
  '.jeg_authorbox', '.jnews_author_box_container', '.jnews_prev_next_container',
  '.comments-area', '#comments', '.post-navigation',
  '.wp-caption-text', 'figcaption',
].join(', ');

// "Related / latest news" style blocks
const LISTING_LIKE_SELECTORS = '[class*="related"], [class*="jeg_postblock"]';

// Where the real post text usually lives
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
  // Never remove something that wraps the article itself (its heading or content),
  // and never the <html>/<body> tags, whatever classes they carry.
  const isSafeToRemove = (el) =>
    !$(el).is('html, body') &&
    $(el).find(`${CONTENT_SELECTORS}, h1`).length === 0;

  $(NOISE_SELECTORS)
    .filter((_, el) => isSafeToRemove(el))
    .remove();

  // Related / latest blocks
  $(LISTING_LIKE_SELECTORS)
    .filter((_, el) => isSafeToRemove(el))
    .remove();
}

// Text of the <p> tags inside an element
function paragraphText($, el) {
  return $(el)
    .find('p')
    .map((_, p) => cleanText($(p).text()))
    .get()
    .filter((txt) => txt.length > 30)
    .join(' ');
}

// Everything between the article's <h1> and the next <h2> ("Author", "More Stories", ...).
// Works whatever the theme calls its containers.
function paragraphsAfterTitle($, ownTitle) {
  const nodes = $('h1, h2, p').toArray();
  const own = norm(ownTitle).slice(0, 30);

  let start = nodes.findIndex(
    (el) => el.name === 'h1' && norm($(el).text()).startsWith(own)
  );
  if (start === -1) start = nodes.findIndex((el) => el.name === 'h1');
  if (start === -1) return '';

  const parts = [];
  let length = 0;

  for (let i = start + 1; i < nodes.length; i++) {
    const el = nodes[i];

    if (el.name === 'h2') {
      if (length > 200) break; // reached "Author" / "More Stories"
      continue;
    }

    const text = cleanText($(el).text());

    if (text.length > 30) {
      parts.push(text);
      length += text.length;
    }

    if (length > MAX_BODY_CHARS * 2) break;
  }

  return parts.join(' ');
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

// Cut long text at the end of a sentence (or at least a word) and add "…"
function trimToLength(text) {
  if (text.length <= MAX_BODY_CHARS) return text;

  const cut = text.slice(0, MAX_BODY_CHARS);
  const lastSentence = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );

  if (lastSentence > MAX_BODY_CHARS * 0.6) {
    return cut.slice(0, lastSentence + 1).trim() + ' …';
  }

  return cut.slice(0, cut.lastIndexOf(' ')).trim() + '…';
}

// Works out the article text from an already-loaded page
function extractBody($, ownTitle, allTitles) {
  // Read the meta description BEFORE stripping anything
  const metaDescription = cleanText(
    $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      ''
  );

  stripNoise($);

  const candidates = [];

  // 1. Anchored on the article heading — doesn't depend on class names
  candidates.push(paragraphsAfterTitle($, ownTitle));

  // 2. Known content containers (keep the one with the most paragraph text)
  for (const selector of BODY_SELECTORS) {
    let best = '';

    $(selector).each((_, el) => {
      const text = paragraphText($, el);
      if (text.length > best.length) best = text;
    });

    candidates.push(best);
  }

  // Drop empty candidates and any that open with another article's headline
  const usable = candidates.filter(
    (c) => c && !startsWithOtherTitle(c, ownTitle, allTitles)
  );

  // Prefer the first candidate with a decent amount of text, else the longest one
  let body =
    usable.find((c) => wordCount(c) >= MIN_GOOD_WORDS) ||
    [...usable].sort((a, b) => b.length - a.length)[0] ||
    '';

  // Last resort: the page's own (short) summary
  if (
    !body &&
    metaDescription.length > 40 &&
    !startsWithOtherTitle(metaDescription, ownTitle, allTitles)
  ) {
    body = metaDescription;
  }

  return trimToLength(body);
}

// ── Fetch page details ────────────────────────────────────────────────────────
async function fetchPageDetails(url, ownTitle, allTitles) {
  try {
    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: REQUEST_HEADERS,
    });

    const $ = cheerio.load(data);

    // Image first: extractBody strips parts of the page
    const image_url = getBestImage($);
    const body = extractBody($, ownTitle, allTitles);

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
    console.log(`   📝 ${wordCount(body)} words: ${body ? body.slice(0, 90) : 'no body found'}`);

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