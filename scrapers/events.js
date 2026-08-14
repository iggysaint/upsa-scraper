import axios from 'axios';
import * as cheerio from 'cheerio';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const EVENTS_URL = 'https://upsa.edu.gh/events/';

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// ── Date window ───────────────────────────────────────────────────────────────
// Keep events from 30 days ago up to 30 days ahead
const today = new Date();
today.setHours(0, 0, 0, 0);

const PAST_CUTOFF = new Date(today);
PAST_CUTOFF.setDate(PAST_CUTOFF.getDate() - 30);

const FUTURE_CUTOFF = new Date(today);
FUTURE_CUTOFF.setDate(FUTURE_CUTOFF.getDate() + 30);

function isWithinWindow(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + 'T00:00:00');
  return d >= PAST_CUTOFF && d <= FUTURE_CUTOFF;
}

function getStatus(dateStr) {
  if (!dateStr) return 'upcoming';
  const d = new Date(dateStr + 'T00:00:00');
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (d < todayMidnight) return 'past';
  if (d.toDateString() === todayMidnight.toDateString()) return 'today';
  return 'upcoming';
}

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function buildDate(dayText, monthText, yearHint) {
  const day = (dayText || '').trim().padStart(2, '0');
  const month = MONTH_MAP[(monthText || '').trim().slice(0, 3)];
  if (!day || !month) return '';
  // Use the year from the page if found, otherwise current year
  const year = yearHint || new Date().getFullYear();
  return `${year}-${month}-${day}`;
}

function parseTimeRange(raw) {
  if (!raw) return { start_time: '', end_time: '' };
  const match = raw.trim().match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
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
  if (text.includes('workshop') || text.includes('training')) return 'Workshop';
  if (text.includes('seminar') || text.includes('webinar') || text.includes('lecture') || text.includes('dialogue')) return 'Seminar';
  if (text.includes('career') || text.includes('fair') || text.includes('recruitment')) return 'Career Fair';
  if (text.includes('hackathon') || text.includes('innovation') || text.includes('startup')) return 'Hackathon';
  if (text.includes('conference') || text.includes('symposium') || text.includes('forum') || text.includes('roundtable')) return 'Conference';
  if (text.includes('sport') || text.includes('game') || text.includes('health walk') || text.includes('astro')) return 'Sports';
  if (text.includes('cultural') || text.includes('concert') || text.includes('carol') || text.includes('drama') || text.includes('thanksgiving')) return 'Cultural';
  if (text.includes('social') || text.includes('party') || text.includes('dinner') || text.includes('homecoming') || text.includes('reception')) return 'Social';
  if (text.includes('congregation') || text.includes('graduation') || text.includes('matriculation') || text.includes('orientation') || text.includes('research') || text.includes('launch')) return 'Academic';
  return 'Other';
}

async function pushToFirebase() {
  console.log('Fetching UPSA events page...');
  const { data } = await axios.get(EVENTS_URL, { timeout: 15000 });
  const $ = cheerio.load(data);

  const allEvents = [];

  $('h5 a[href*="upsa.edu.gh/events/"]').each((_, el) => {
    const titleEl = $(el);
    const title = cleanText(titleEl.text());
    const link = titleEl.attr('href') || '';
    if (!title || !link) return;

    const parent = titleEl.closest('div, li, article, section, p').first();
    const blockText = cleanText(parent.text());

    // Extract day, month, optional year from block text
    const dateMatch = blockText.match(/^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s+(\d{4}))?/i);
    let dateStr = '';
    if (dateMatch) {
      dateStr = buildDate(dateMatch[1], dateMatch[2], dateMatch[3]);
    }

    // ── WINDOW FILTER: skip if outside 30-day past / 30-day future window ──
    if (dateStr && !isWithinWindow(dateStr)) return;

    const timeMatch = blockText.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
    const { start_time, end_time } = parseTimeRange(timeMatch ? timeMatch[0] : '');

    let venue = '';
    const venueMatch = blockText.match(/(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*(.+?)(?:\n|The |This |[A-Z]{2})/);
    if (venueMatch) venue = cleanText(venueMatch[1]).slice(0, 100);

    const imgSrc = parent.find('img').first().attr('src') || parent.find('img').first().attr('data-src') || '';
    const image_url = imgSrc && imgSrc.startsWith('http') && !imgSrc.includes('logo') && !imgSrc.includes('cropped') ? imgSrc : '';

    const status = getStatus(dateStr);

    allEvents.push({ title, link, dateStr, start_time, end_time, venue, image_url, status });
  });

  console.log(`Found ${allEvents.length} events within the 30-day window`);

  if (!allEvents.length) {
    console.log('No events in window — check UPSA site or selectors');
    return;
  }

  // Log breakdown
  const upcoming = allEvents.filter(e => e.status === 'upcoming').length;
  const todayEvts = allEvents.filter(e => e.status === 'today').length;
  const past = allEvents.filter(e => e.status === 'past').length;
  console.log(`  Upcoming: ${upcoming} | Today: ${todayEvts} | Past (last 30d): ${past}`);

  let added = 0; let skipped = 0; let updated = 0;

  for (const e of allEvents) {
    const slug = e.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');
    const ref = db.collection('events').doc(slug);
    const existing = await ref.get();

    if (existing.exists) {
      const d = existing.data();
      // Update status in case event moved from upcoming to past/today
      const needsStatusUpdate = d.status !== e.status;
      const needsDescUpdate = !d.description || d.description.length < 10;

      if (!needsStatusUpdate && !needsDescUpdate) {
        skipped++;
        continue;
      }

      if (needsDescUpdate) {
        try {
          const { data: detailHtml } = await axios.get(e.link, { timeout: 10000 });
          const $d = cheerio.load(detailHtml);
          $d('nav, header, footer, script, style').remove();
          let description = '';
          for (const sel of ['.entry-content', '.jeg_post_content', '.post-content']) {
            const el = $d(sel).first();
            if (el.length) { description = cleanText(el.text()); if (description.length > 30) break; }
          }
          if (description.length > 600) description = description.slice(0, 600) + '...';
          await ref.update({
            description,
            status: e.status,
            image_url: e.image_url || d.image_url,
          });
        } catch {
          if (needsStatusUpdate) await ref.update({ status: e.status });
        }
      } else {
        await ref.update({ status: e.status });
      }

      updated++;
      continue;
    }

    // New event — fetch description from detail page
    console.log(`  Fetching detail: ${e.title.slice(0, 55)}...`);
    let description = '';
    let detailVenue = e.venue;

    try {
      const { data: detailHtml } = await axios.get(e.link, { timeout: 10000 });
      const $d = cheerio.load(detailHtml);
      $d('nav, header, footer, script, style').remove();

      for (const sel of ['.entry-content', '.jeg_post_content', '.post-content']) {
        const el = $d(sel).first();
        if (el.length) { description = cleanText(el.text()); if (description.length > 30) break; }
      }
      if (!description) {
        const paras = [];
        $d('article p, .post p').each((_, el) => {
          const txt = cleanText($d(el).text());
          if (txt.length > 20) paras.push(txt);
        });
        description = paras.join(' ');
      }
      if (description.length > 600) description = description.slice(0, 600) + '...';

      if (!detailVenue) {
        const venueSel = $d('.tribe-venue, .tribe-address, [class*="venue"]').first().text();
        if (venueSel) detailVenue = cleanText(venueSel).slice(0, 100);
      }
    } catch { /* silent */ }

    const category = detectCategory(e.title, description);

    await ref.set({
      title: e.title,
      description,
      image_url: e.image_url,
      source_url: e.link,
      date: e.dateStr,
      start_time: e.start_time,
      end_time: e.end_time,
      venue: detailVenue,
      category,
      status: e.status,           // 'upcoming' | 'today' | 'past'
      organiser: 'UPSA',
      is_active: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`  Added: ${e.title.slice(0, 50)} | ${e.dateStr} | ${e.status} | ${category}`);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\nDone — ${added} added, ${updated} updated, ${skipped} skipped`);

  // ── Clean up stale events outside the window from Firestore ──────────────
  // Mark events older than 30 days as is_active: false so they stop showing
  console.log('\nCleaning up stale events...');
  const staleSnap = await db.collection('events')
    .where('is_active', '==', true)
    .get();

  let deactivated = 0;
  for (const doc of staleSnap.docs) {
    const d = doc.data();
    if (d.date && !isWithinWindow(d.date)) {
      await doc.ref.update({ is_active: false, status: 'past' });
      deactivated++;
    }
  }
  if (deactivated > 0) {
    console.log(`Deactivated ${deactivated} stale events outside the window`);
  }
}

pushToFirebase().catch(err => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});