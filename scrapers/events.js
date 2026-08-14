import puppeteer from 'puppeteer';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const EVENTS_URL = 'https://upsa.edu.gh/events/';
const PAST_LIMIT  = 10; // max expired events to keep

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function buildDate(day, month, year) {
  const d = String(day).padStart(2, '0');
  const m = MONTH_MAP[String(month).trim().slice(0, 3)];
  if (!d || !m) return '';
  const y = year || new Date().getFullYear();
  return `${y}-${m}-${d}`;
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

function detectCategory(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('workshop') || text.includes('training'))                                          return 'Workshop';
  if (text.includes('seminar') || text.includes('webinar') || text.includes('lecture'))                return 'Seminar';
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
  return url
    .replace('https://upsa.edu.gh/', '')
    .replace(/\/$/, '')
    .replace(/\//g, '-');
}

// ── Scrape a single tab using Puppeteer ───────────────────────────────────────
// Returns array of { title, link, date, start_time, end_time, image_url, status }

async function scrapeTab(page, status) {
  // Wait for events to render
  await page.waitForSelector('h5 a, .event-title a, article h2 a', { timeout: 8000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));

  const events = await page.evaluate((statusLabel) => {
    const results = [];
    const MONTH_MAP = {
      jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
      jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
    };

    // Find all event links — UPSA uses h5 > a pattern
    const links = Array.from(document.querySelectorAll('h5 a[href*="upsa.edu.gh/events/"]'));

    links.forEach(el => {
      const title = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const link  = el.href || '';
      if (!title || !link || link === 'https://upsa.edu.gh/events/') return;

      // Walk up to find the containing block
      let block = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!block) break;
        if (['DIV','LI','ARTICLE','SECTION'].includes(block.tagName)) break;
        block = block.parentElement;
      }
      const blockText = block ? (block.innerText || '').replace(/\s+/g, ' ').trim() : '';

      // Date: "17 Aug" or "17 Aug 2026"
      const dateMatch = blockText.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?/i);
      let date = '';
      if (dateMatch) {
        const d = String(dateMatch[1]).padStart(2, '0');
        const m = MONTH_MAP[dateMatch[2].toLowerCase().slice(0,3)];
        const y = dateMatch[3] || new Date().getFullYear();
        if (d && m) date = `${y}-${m}-${d}`;
      }

      // Time
      const timeMatch = blockText.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
      const timeStr = timeMatch ? timeMatch[0] : '';

      // Image
      const img = block ? block.querySelector('img') : null;
      const imgSrc = img ? (img.src || img.dataset.src || '') : '';
      const image_url = imgSrc && imgSrc.startsWith('http') && !imgSrc.includes('logo') ? imgSrc : '';

      results.push({ title, link, date, timeStr, image_url, status: statusLabel });
    });

    return results;
  }, status);

  // Parse time ranges
  return events.map(e => {
    const { start_time, end_time } = parseTimeRange(e.timeStr);
    return { ...e, start_time, end_time };
  });
}

// ── Click a tab by its visible text ──────────────────────────────────────────
async function clickTab(page, tabText) {
  await page.evaluate((text) => {
    const tabs = Array.from(document.querySelectorAll('a, button, li, span'));
    const tab = tabs.find(el => (el.textContent || '').trim().toLowerCase() === text.toLowerCase());
    if (tab) tab.click();
  }, tabText);
  await new Promise(r => setTimeout(r, 2000));
}

// ── Fetch description from detail page ───────────────────────────────────────
async function fetchDescription(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await new Promise(r => setTimeout(r, 1000));
    const desc = await page.evaluate(() => {
      for (const sel of ['.entry-content', '.jeg_post_content', '.post-content', 'article']) {
        const el = document.querySelector(sel);
        if (el) {
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

  console.log('Loading UPSA events page...');
  await page.goto(EVENTS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  // ── Scrape Upcoming tab (already active by default) ──
  console.log('\n[1/3] Scraping Upcoming tab...');
  const upcomingEvents = await scrapeTab(page, 'upcoming');
  console.log(`  Found ${upcomingEvents.length} upcoming events`);

  // ── Click Happening tab ──
  console.log('\n[2/3] Scraping Happening tab...');
  await clickTab(page, 'Happening');
  const happeningEvents = await scrapeTab(page, 'today');
  console.log(`  Found ${happeningEvents.length} happening today`);

  // ── Click Expired tab ──
  console.log('\n[3/3] Scraping Expired tab (last 10 only)...');
  await clickTab(page, 'Expired');
  const allExpired = await scrapeTab(page, 'past');
  // Take only the last 10 expired (most recent past events appear first or last depending on site)
  const expiredEvents = allExpired.slice(0, PAST_LIMIT);
  console.log(`  Found ${allExpired.length} expired, keeping ${expiredEvents.length}`);

  const allEvents = [...happeningEvents, ...upcomingEvents, ...expiredEvents];
  console.log(`\nTotal to process: ${allEvents.length} events`);

  if (!allEvents.length) {
    console.log('No events found — check selectors or site structure');
    await browser.close();
    return;
  }

  // Open a second page for detail fetches
  const detailPage = await browser.newPage();
  await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  let added = 0; let skipped = 0; let updated = 0;

  for (const e of allEvents) {
    const slug = slugFromUrl(e.link);
    const ref  = db.collection('events').doc(slug);
    const existing = await ref.get();

    if (existing.exists) {
      const d = existing.data();
      const needsStatusUpdate = d.status !== e.status;
      const needsDesc = !d.description || d.description.length < 10;

      if (!needsStatusUpdate && !needsDesc) { skipped++; continue; }

      if (needsDesc) {
        console.log(`  Updating desc: ${e.title.slice(0, 50)}...`);
        const description = await fetchDescription(detailPage, e.link);
        await ref.update({ description, status: e.status, image_url: e.image_url || d.image_url });
        await page.goto(EVENTS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      } else {
        await ref.update({ status: e.status });
      }
      updated++;
      continue;
    }

    // New event — fetch detail page
    console.log(`  Fetching: ${e.title.slice(0, 55)}...`);
    const description = await fetchDescription(detailPage, e.link);
    const category    = detectCategory(e.title, description);

    await ref.set({
      title:       e.title,
      description,
      image_url:   e.image_url,
      source_url:  e.link,
      date:        e.date,
      start_time:  e.start_time,
      end_time:    e.end_time,
      venue:       '',
      category,
      status:      e.status,     // 'upcoming' | 'today' | 'past'
      organiser:   'UPSA',
      is_active:   true,
      created_at:  admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`  Added: ${e.title.slice(0, 50)} | ${e.date} | ${e.status} | ${category}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Deactivate events no longer in any tab ────────────────────────────────
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