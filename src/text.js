// Turning UPSA HTML into plain, safe text, and the content rules carried over
// from the original scrapers (categories, hostel and fee keywords).
import * as cheerio from 'cheerio';

// Plain text with paragraph breaks; scripts, styles and markup removed. The
// app renders text only, never HTML.
export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  $('script, style, noscript, iframe, form').remove();
  $('br').replaceWith('\n');
  $('p, li, h1, h2, h3, h4, h5, h6, div, tr').each((_, el) => {
    $(el).append('\n');
  });
  return $('#root')
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const decodeTitle = (html) => htmlToText(html).replace(/\s+/g, ' ').trim();

// Whole-word matching, so "hall" doesn't match "challenge" or "room" match
// "classroom" (the original substring check did).
const wordMatcher = (words) =>
  new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

const HOSTEL = wordMatcher([
  'hostel', 'hostels', 'accommodation', 'hms', 'residential', 'hall of residence', 'halls of residence',
  'apply for room', 'room allocation', 'room allocations', 'check-in', 'check in', 'eviction', 'vacate',
]);
const FEE = wordMatcher([
  'fee', 'fees', 'payment', 'payments', 'financial clearance', 'school fees', 'tuition',
  'semester fees', 'portal fees', 'ufis', 'interpay', 'fee payment',
]);

// Title only: news stories often mention accommodation in passing, and
// hostel notices publish without review (the original scraper also required
// a title match).
export const isHostelRelated = (title) => HOSTEL.test(title);
// Fees: the title must be about fees/payment (bodies mention fees in passing).
export const isFeeRelated = (title) => FEE.test(title);

// Unchanged from the original announcements scraper, so the app's category
// filter chips keep working the same way.
export function detectCategory(title) {
  const t = title.toLowerCase();
  if (t.includes('urgent') || t.includes('important')) return 'urgent';
  if (['exam', 'reschedule', 'cancellation', 'result', 'registration', 'portal', 'timetable', 'academic'].some((k) => t.includes(k))) return 'academic';
  if (['event', 'dialogue', 'ceremony', 'matriculation', 'graduation', 'convene'].some((k) => t.includes(k))) return 'event';
  return 'academic';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

// First explicit calendar date in free text, as YYYY-MM-DD (Ghana uses UTC
// all year, Africa/Accra = UTC+0). Handles "8th November, 2026",
// "November 8, 2026", "08/11/2026" (day first) and "2026-11-08".
export function findDate(text) {
  if (!text) return null;
  const s = text.toLowerCase();
  const month = `(${MONTHS.join('|')})`;
  const patterns = [
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month},?\\s+(\\d{4})\\b`), (m) => isoOf(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1])],
    [new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`), (m) => isoOf(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2])],
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => isoOf(+m[1], +m[2], +m[3])],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, (m) => isoOf(+m[3], +m[2], +m[1])],
  ];
  for (const [re, toIso] of patterns) {
    const m = s.match(re);
    const iso = m && toIso(m);
    if (iso) return iso;
  }
  return null;
}
