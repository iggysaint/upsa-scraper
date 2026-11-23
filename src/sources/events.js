// Events from https://upsa.edu.gh/events/ (no WordPress API for events).
// Plain HTML: Cheerio is enough, no headless browser (CLAUDE.md §6.1).
// The listing has day and month but no year, so the date comes from each
// event's own page; only upcoming, happening and recent past events are
// opened, to keep traffic to UPSA low.
import * as cheerio from 'cheerio';
import { fetchText, pause } from '../http.js';
import { decodeTitle, findDate, htmlToText } from '../text.js';

export const EVENTS_URL = 'https://upsa.edu.gh/events/';
const PANELS = { upcoming: '#tab-upcoming', happening: '#tab-happening', expired: '#tab-expired' };
const RECENT_PAST_DAYS = 30;
const MAX_DETAIL_PAGES = 40;

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

// Listing page → cards. Throws when the page doesn't have the event tabs at
// all (layout changed or error page): that's a failure, not "no events".
export function parseListing(html) {
  const $ = cheerio.load(html);
  const found = Object.values(PANELS).filter((sel) => $(sel).length > 0);
  if (found.length < 2) throw new Error('parse_failed: event tabs not found on the events page');
  const cards = [];
  for (const [status, sel] of Object.entries(PANELS)) {
    $(sel)
      .find('.item-event')
      .each((_, el) => {
        const card = $(el);
        const link = card.find('h5.title a').first();
        const href = link.attr('href');
        if (!href) return;
        const [startTime, endTime] = clean(card.find('.meta .time').text()).split(/\s+-\s+/);
        const img = card.find('.image img').attr('src');
        cards.push({
          status,
          sourceUrl: href,
          title: decodeTitle(link.html() ?? ''),
          startTime: startTime || null,
          endTime: endTime || null,
          venue: clean(card.find('.meta .location').text()) || null,
          imageUrl: img && img.startsWith('https://') ? img : null,
        });
      });
  }
  return cards;
}

// Event page → full dates (with year), times, venue and description.
export function parseDetail(html) {
  const $ = cheerio.load(html);
  const box = (word) => $('.tp-info-box').filter((_, el) => clean($(el).find('.heading').text()).toLowerCase().startsWith(word));
  const lines = (el) => el.find('p').not('.heading').map((_, p) => clean($(p).text())).get().filter(Boolean);
  const start = lines(box('start'));
  const finish = lines(box('finish'));
  const address = lines(box('address'));
  const date = findDate(start.join(' '));
  if (!date) throw new Error('parse_failed: event page has no start date');
  return {
    date,
    startTime: start[0] ?? null,
    endTime: finish[0] ?? null,
    venue: address[0] ?? null,
    description: htmlToText($('.summary .entry-content').first().html() ?? $('.entry-content').last().html() ?? ''),
  };
}

const daysAgo = (iso, today) => (Date.parse(today) - Date.parse(iso)) / 86_400_000;

export async function fetchEvents({ today = new Date().toISOString().slice(0, 10) } = {}) {
  const cards = parseListing(await fetchText(EVENTS_URL));
  const items = [];
  let opened = 0;
  for (const card of cards) {
    if (opened >= MAX_DETAIL_PAGES) break;
    await pause(500);
    opened++;
    const detail = parseDetail(await fetchText(card.sourceUrl));
    // Past events are listed newest first: stop at the first one older than
    // the window.
    if (card.status === 'expired' && daysAgo(detail.date, today) > RECENT_PAST_DAYS) break;
    items.push({
      sourceUrl: card.sourceUrl,
      title: card.title,
      description: detail.description,
      date: detail.date,
      startTime: detail.startTime ?? card.startTime,
      endTime: detail.endTime ?? card.endTime,
      venue: detail.venue ?? card.venue,
      imageUrl: card.imageUrl,
    });
  }
  return { cards: cards.length, items };
}
