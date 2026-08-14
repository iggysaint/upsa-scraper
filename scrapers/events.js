import puppeteer from 'puppeteer';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const EVENTS_URL = 'https://upsa.edu.gh/events/';
const PAST_LIMIT  = 10;

const MONTH_MAP = {
  jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
  jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectCategory(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('workshop') || text.includes('training'))                                         return 'Workshop';
  if (text.includes('seminar') || text.includes('webinar') || text.includes('lecture'))               return 'Seminar';
  if (text.includes('career') || text.includes('fair') || text.includes('recruitment'))               return 'Career Fair';
  if (text.includes('hackathon') || text.includes('innovation') || text.includes('startup'))          return 'Hackathon';
  if (text.includes('conference') || text.includes('symposium') || text.includes('forum'))            return 'Conference';
  if (text.includes('sport') || text.includes('game') || text.includes('health walk'))                return 'Sports';
  if (text.includes('cultural') || text.includes('concert') || text.includes('carol'))                return 'Cultural';
  if (text.includes('social') || text.includes('party') || text.includes('dinner'))                   return 'Social';
  if (text.includes('graduation') || text.includes('matriculation') || text.includes('orientation'))  return 'Academic';
  return 'Other';
}

function slugFromUrl(url) {
  return (url || '')
    .replace('https://upsa.edu.gh/', '')
    .replace(/\/$/, '')
    .replace(/\//g, '-');
}

function parseTimeRange(raw) {
  if (!raw) return { start_time: '', end_time: '' };
  const match = raw.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
  if (!match) return { start_time: '', end_time: '' };
  const to24 = (t) => {
    const m = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return t.trim();
    let h = parseInt(m[1]);
    const min = m[2];
    const period = (m[3] || '').toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  };
  return { start_time: to24(match[1]), end_time: to24(match[2]) };
}

// ── Scrape events from a specific tab panel ID ────────────────────────────────
async function scrapeTabPanel(page, panelId, status, limit = null) {
  const events = await page.evaluate((pid, statusLabel, lim, monthMap) => {
    const panel = document.getElementById(pid);
    if (!panel) return [];

    const items = Array.from(panel.querySelectorAll('.item-event, [class*="item-event"]'));
    const results = [];

    for (const item of items) {
      if (lim && results.length >= lim) break;

      // Title and link
      const linkEl = item.querySelector('h5 a, h4 a, h3 a, .entry-title a, a[href*="upsa.edu.gh/events/"]');
      if (!linkEl) continue;
      const title = (linkEl.textContent || '').replace(/\s+/g, ' ').trim();
      const link  = linkEl.href || '';
      if (!title || !link || link.endsWith('/events/')) continue;

      // Date — look for day number and month text
      const dayEl   = item.querySelector('[class*="day"], .day, .date-day');
      const monthEl = item.querySelector('[class*="month"], .month, .date-month');
      const yearEl  = item.querySelector('[class*="year"], .year, .date-year');

      let date = '';
      if (dayEl && monthEl) {
        const d = (dayEl.textContent || '').trim().padStart(2, '0');
        const mKey = (monthEl.textContent || '').trim().toLowerCase().slice(0, 3);
        const m = monthMap[mKey];
        const y = yearEl ? (yearEl.textContent || '').trim() : new Date().getFullYear();
        if (d && m) date = `${y}-${m}-${d}`;
      }

      // Fallback: parse date from full block text
      if (!date) {
        const blockText = (item.innerText || '').replace(/\s+/g, ' ');
        const dm = blockText.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?/i);
        if (dm) {
          const d = dm[1].padStart(2, '0');
          const mKey = dm[2].toLowerCase().slice(0, 3);
          const m = monthMap[mKey];
          const y = dm[3] || new Date().getFullYear();
          if (d && m) date = `${y}-${m}-${d}`;
        }
      }

      // Time — look for time element or text pattern
      const timeEl = item.querySelector('.time, [class*="time"], time');
      const timeText = timeEl
        ? (timeEl.textContent || '').trim()
        : ((item.innerText || '').match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i) || [])[0] || '';

      // Image
      const img = item.querySelector('img');
      const imgSrc = img ? (img.src || img.dataset.src || img.dataset.lazySrc || '') : '';
      const image_url = imgSrc && imgSrc.startsWith('http') && !imgSrc.includes('logo') && !imgSrc.includes('cropped') ? imgSrc : '';

      results.push({ title, link, date, timeText, image_url, status: statusLabel });
    }

    return results;
  }, panelId, status, limit, MONTH_MAP);

  // Parse time ranges in Node (not browser)
  return events.map(e => {
    const { start_time, end_time } = parseTimeRange(e.timeText);
    return { ...e, start_time, end_time };
  });
}

// ── Fetch description from event detail page ──────────────────────────────────
async function fetchDescription(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await new Promise(r => setTimeout(r, 800));
    const desc = await page.evaluate(() => {
      for (const sel of ['.entry-content', '.jeg_post_content', '.post-content', 'article .content', 'article']) {
        const el = document.querySelector(sel);
        if (el) {
          // Remove nav/header/footer noise
          ['nav','header','footer','.navigation'].forEach(s => {
            el.querySelectorAll(s).forEach(n => n.remove());
          });
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (text.length > 30) return text;
        }
      }
      return '';
    });
    return desc.length > 600 ? desc.slice(0, 600) + '...' : desc;
  } catch {
    return '';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function pushToFirebase() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Loading UPSA events page...');
  await page.goto(EVENTS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // All 3 tab panels are in the DOM simultaneously — no clicking needed
  console.log('\n[1/3] Scraping #tab-upcoming...');
  const upcomingEvents  = await scrapeTabPanel(page, 'tab-upcoming',  'upcoming', null);
  console.log(`  Found ${upcomingEvents.length} upcoming`);

  console.log('[2/3] Scraping #tab-happening...');
  const happeningEvents = await scrapeTabPanel(page, 'tab-happening', 'today',    null);
  console.log(`  Found ${happeningEvents.length} happening today`);

  console.log('[3/3] Scraping #tab-expired (last 10 only)...');
  const expiredEvents   = await scrapeTabPanel(page, 'tab-expired',   'past',     PAST_LIMIT);
  console.log(`  Keeping ${expiredEvents.length} past events`);

  const allEvents = [...happeningEvents, ...upcomingEvents, ...expiredEvents];
  console.log(`\nTotal to process: ${allEvents.length} events`);

  if (!allEvents.length) {
    console.log('No events found — the panel IDs may have changed on the site');
    await browser.close();
    return;
  }

  // Detail page for fetching descriptions
  const detailPage = await browser.newPage();
  await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  let added = 0; let skipped = 0; let updated = 0;

  for (const e of allEvents) {
    const slug = slugFromUrl(e.link);
    if (!slug) { skipped++; continue; }

    const ref      = db.collection('events').doc(slug);
    const existing = await ref.get();

    if (existing.exists) {
      const d = existing.data();
      const needsStatusUpdate = d.status !== e.status;
      const needsDesc         = !d.description || d.description.length < 10;

      if (!needsStatusUpdate && !needsDesc) { skipped++; continue; }

      if (needsDesc) {
        console.log(`  Updating: ${e.title.slice(0, 50)}...`);
        const description = await fetchDescription(detailPage, e.link);
        await ref.update({ description, status: e.status, image_url: e.image_url || d.image_url });
      } else {
        await ref.update({ status: e.status });
      }
      updated++;
      continue;
    }

    // New event
    console.log(`  Fetching: ${e.title.slice(0, 55)}...`);
    const description = await fetchDescription(detailPage, e.link);
    const category    = detectCategory(e.title, description);

    await ref.set({
      title:      e.title,
      description,
      image_url:  e.image_url,
      source_url: e.link,
      date:       e.date,
      start_time: e.start_time,
      end_time:   e.end_time,
      venue:      '',
      category,
      status:     e.status,
      organiser:  'UPSA',
      is_active:  true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`  Added: ${e.title.slice(0, 50)} | ${e.date} | ${e.status} | ${category}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Deactivate events no longer on the site ───────────────────────────────
  const currentSlugs = new Set(allEvents.map(e => slugFromUrl(e.link)));
  const activeSnap   = await db.collection('events').where('is_active', '==', true).get();
  let deactivated = 0;
  for (const doc of activeSnap.docs) {
    if (!currentSlugs.has(doc.id)) {
      await doc.ref.update({ is_active: false });
      deactivated++;
    }
  }

  await browser.close();
  console.log(`\nDone — ${added} added, ${updated} updated, ${skipped} skipped, ${deactivated} deactivated`);
}

pushToFirebase().catch(err => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});