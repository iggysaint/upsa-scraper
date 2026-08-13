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

const EVENTS_URL = 'https://upsa.edu.gh/events/';

const MONTH_MAP = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// ── Parse date from listing page format e.g. "17 Aug" with year context ───────
function parseDateFromListing(dayText, monthText, year) {
  const day   = dayText.trim().padStart(2, '0');
  const month = MONTH_MAP[monthText.trim().slice(0, 3)];
  if (!day || !month) return '';
  return `${year}-${month}-${day}`;
}

// ── Parse time range e.g. "10:00 am - 12:00 pm" → { start, end } ─────────────
function parseTimeRange(raw) {
  if (!raw) return { start_time: '', end_time: '' };
  const clean = raw.trim().toLowerCase();
  const match = clean.match(/(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:\d{2}\s*(?:am|pm)?)/);
  if (!match) return { start_time: '', end_time: '' };

  const to24 = (t) => {
    const m = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (!m) return t.trim();
    let h = parseInt(m[1]);
    const min = m[2];
    const period = m[3];
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  };

  return { start_time: to24(match[1]), end_time: to24(match[2]) };
}

function detectCategory(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('workshop') || text.includes('training'))                                           return 'Workshop';
  if (text.includes('seminar') || text.includes('webinar') || text.includes('lecture'))                 return 'Seminar';
  if (text.includes('career') || text.includes('fair') || text.includes('recruitment'))                 return 'Career Fair';
  if (text.includes('hackathon') || text.includes('innovation') || text.includes('tech'))               return 'Hackathon';
  if (text.includes('conference') || text.includes('symposium') || text.includes('forum'))              return 'Conference';
  if (text.includes('sport') || text.includes('game') || text.includes('tournament') || text.includes('health walk')) return 'Sports';
  if (text.includes('cultural') || text.includes('concert') || text.includes('carol') || text.includes('drama'))    return 'Cultural';
  if (text.includes('social') || text.includes('party') || text.includes('dinner') || text.includes('homecoming'))  return 'Social';
  if (text.includes('academic') || text.includes('research') || text.includes('graduation') || text.includes('congregation') || text.includes('matriculation')) return 'Academic';
  return 'Other';
}

// ── Fetch full description + image from individual event page ─────────────────
async function fetchEventDetails(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);
    $('nav, header, footer, script, style').remove();

    let description = '';
    for (const sel of ['.entry-content', '.jeg_post_content', '.post-content', 'article .content']) {
      const el = $(sel).first();
      if (el.length) {
        description = cleanText(el.text());
        if (description.length > 30) break;
      }
    }
    if (!description) {
      const paras = [];
      $('article p, .post p').each((_, el) => {
        const txt = cleanText($(el).text());
        if (txt.length > 20) paras.push(txt);
      });
      description = paras.join(' ');
    }
    if (description.length > 600) description = description.slice(0, 600) + '…';

    let image_url = '';
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('avatar') && !src.includes('cropped')) {
        image_url = src;
        return false;
      }
    });

    return { description, image_url };
  } catch {
    return { description: '', image_url: '' };
  }
}

// ── Main scraper ──────────────────────────────────────────────────────────────
async function pushToFirebase() {
  console.log('🎉 Fetching UPSA events page...');
  const { data } = await axios.get(EVENTS_URL, { timeout: 15000 });
  const $ = cheerio.load(data);

  const currentYear = new Date().getFullYear();
  const events = [];

  // Each event article block
  $('article, .jeg_post, .type-tribe_events').each((_, el) => {
    const titleEl = $(el).find('h3 a, h5 a, .jeg_post_title a').first();
    const title   = cleanText(titleEl.text());
    const link    = titleEl.attr('href') || '';
    if (!title || !link || !link.startsWith('https://upsa.edu.gh')) return;

    // Date — day number + month text are separate elements
    const dayText   = cleanText($(el).find('.tribe-event-schedule-details .tribe-event-date-start, .event-date .day, [class*="day"]').first().text());
    const monthText = cleanText($(el).find('[class*="month"]').first().text());

    // Fallback: grab the visible day/month text from the card
    let dateStr = '';
    const cardText = cleanText($(el).text());
    const dateMatch = cardText.match(/^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
    if (dateMatch) {
      dateStr = parseDateFromListing(dateMatch[1], dateMatch[2], currentYear);
    }

    // Time — grab from the listing card directly
    const timeRaw = cleanText($(el).find('.tribe-event-schedule-details, [class*="time"], .event-time').first().text());
    const { start_time, end_time } = parseTimeRange(timeRaw);

    // Venue
    const venue = cleanText($(el).find('.tribe-venue, [class*="venue"], .tribe-address').first().text()).slice(0, 100);

    // Thumbnail from listing
    const thumbSrc = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src') || '';
    const image_url = (thumbSrc && thumbSrc.startsWith('http') && !thumbSrc.includes('logo')) ? thumbSrc : '';

    events.push({ title, link, dateStr, start_time, end_time, venue, image_url });
  });

  console.log(`📋 Found ${events.length} events`);
  if (!events.length) { console.log('⚠️  No events — check selectors'); return; }

  let added = 0; let skipped = 0; let updated = 0;

  for (const e of events) {
    const slug = e.link
      .replace('https://upsa.edu.gh/', '')
      .replace(/\/$/, '')
      .replace(/\//g, '-');
    const ref      = db.collection('events').doc(slug);
    const existing = await ref.get();

    // Determine if upcoming — skip very old events
    if (e.dateStr) {
      const eventDate = new Date(e.dateStr + 'T00:00:00');
      const cutoff    = new Date();
      cutoff.setMonth(cutoff.getMonth() - 1); // keep events up to 1 month old
      if (eventDate < cutoff) { skipped++; continue; }
    }

    if (existing.exists) {
      const d = existing.data();
      if (!d.description || d.description.length < 10) {
        const details = await fetchEventDetails(e.link);
        await ref.update({ description: details.description, image_url: details.image_url || d.image_url });
        updated++;
      } else { skipped++; }
      continue;
    }

    // New event — fetch full description
    console.log(`📄 Fetching: ${e.title.slice(0, 55)}...`);
    const details  = await fetchEventDetails(e.link);
    const category = detectCategory(e.title, details.description);

    await ref.set({
      title:       e.title,
      description: details.description,
      image_url:   e.image_url || details.image_url,
      source_url:  e.link,
      date:        e.dateStr,
      start_time:  e.start_time,
      end_time:    e.end_time,
      venue:       e.venue,
      category,
      organiser:   'UPSA',
      is_active:   true,
      created_at:  admin.firestore.FieldValue.serverTimestamp(),
    });

    added++;
    console.log(`✅ ${e.title.slice(0, 55)} | 📅 ${e.dateStr} | 🏷️ ${category}`);
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n🎉 Done — ${added} added, ${updated} updated, ${skipped} skipped`);
}

pushToFirebase().catch(err => {
  console.error('❌ Scraper failed:', err.message);
  process.exit(1);
});