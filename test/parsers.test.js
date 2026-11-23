// Parser tests against pages saved from upsa.edu.gh on 2026-11-23
// (test/fixtures). Run: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseDetail, parseListing } from '../src/sources/events.js';
import { announcementItems, feeItems, hostelItems, parsePosts } from '../src/sources/posts.js';
import { detectCategory, findDate, htmlToText, isFeeRelated, isHostelRelated } from '../src/text.js';
import { assertAllowed } from '../src/http.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const posts = JSON.parse(fixture('posts-announcement.json'));

describe('posts (WordPress API)', () => {
  const items = parsePosts(posts);

  it('maps every post to a clean item with its UPSA link and publication time', () => {
    assert.equal(items.length, posts.length);
    for (const i of items) {
      assert.match(i.sourceUrl, /^https:\/\/upsa\.edu\.gh\//);
      assert.ok(i.title.length > 0 && !/[<>]|&#\d+;/.test(i.title), `clean title: ${i.title}`);
      assert.ok(!/<[a-z]/i.test(i.body), 'body has no HTML');
      assert.match(i.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it('treats a non-list response as broken, never as "no posts"', () => {
    assert.throws(() => parsePosts({ code: 'rest_no_route' }), /parse_failed/);
    assert.deepEqual(parsePosts([]), []);
  });

  it('keeps the original announcement categories and files news/opinions as articles', () => {
    assert.equal(detectCategory('Notice to Graduands: 5th Session of the 18th Congregation Ceremony'), 'event');
    assert.equal(detectCategory('Release of First Semester Examination Results'), 'academic');
    assert.equal(detectCategory('URGENT: Change of venue'), 'urgent');
    const news = parsePosts(posts.slice(0, 1), 'articles');
    assert.equal(news[0].category, 'articles');
  });

  it('picks hostel notices by whole words (no "challenge" or "classroom" false matches)', () => {
    const hostel = hostelItems({ announcements: items, news: [] });
    assert.ok(hostel.some((h) => /hostel room reservation/i.test(h.title)));
    assert.equal(isHostelRelated('Leadership challenge for students'), false);
    assert.equal(isHostelRelated('New classroom block opened'), false);
    assert.equal(isHostelRelated('Opening of hostel application portal'), true);
    // A news story that only mentions accommodation in its text is not a notice.
    assert.equal(hostelItems({ announcements: [], news: [{ title: 'UPSA Engages President on Expansion', body: 'more student accommodation is needed', sourceUrl: 'https://upsa.edu.gh/x/' }] }).length, 0);
  });

  it('turns fee notices into deadline drafts with a suggested date', () => {
    const fees = feeItems({ announcements: items });
    const ufis = fees.find((f) => /UFIS/.test(f.title));
    assert.ok(ufis, 'UFIS fee platform notice is a fee item');
    assert.equal(isFeeRelated('Display of results'), false);
    for (const f of fees) assert.ok(f.date === null || /^\d{4}-\d{2}-\d{2}$/.test(f.date));
  });

  it('sends announcements, news and opinions as one feed', () => {
    assert.equal(announcementItems({ announcements: items, news: items.slice(0, 1), opinions: [] }).length, items.length + 1);
  });
});

describe('events page', () => {
  it('reads cards from the tabs; empty upcoming/happening tabs are a valid empty result', () => {
    const cards = parseListing(fixture('events-listing.html'));
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c) => c.status === 'expired'));
    assert.ok(cards.every((c) => c.sourceUrl.startsWith('https://upsa.edu.gh/events/')));
    assert.ok(cards.every((c) => c.title && !/&#\d+;/.test(c.title)));
  });

  it('reports a page without the event tabs as broken', () => {
    assert.throws(() => parseListing('<html><body><h1>Site maintenance</h1></body></html>'), /parse_failed/);
  });

  it('reads the full date, times, venue and description from an event page', () => {
    const d = parseDetail(fixture('event-detail.html'));
    assert.equal(d.date, '2026-11-08');
    assert.equal(d.startTime, '6:30 am');
    assert.equal(d.endTime, '10:00 am');
    assert.equal(d.venue, 'Kofi Ohene-Konadu Auditorium');
    assert.match(d.description, /Matriculation Thanksgiving Service/);
  });

  it('treats UPSA\'s "12:00 am to 12:00 am" placeholder as an all-day event with no time', () => {
    const html = fixture('event-detail.html')
      .replace('<p>6:30 am</p>', '<p>12:00 am</p>')
      .replace('<p>10:00 am</p>', '<p>12:00 am</p>')
      .replace(/(<p>12:00 am<\/p>\s*(?:<[^>]+>\s*)*?<p>)November 8, 2026(?![\s\S]*12:00 am)/, '$1November 9, 2026');
    const d = parseDetail(html);
    assert.equal(d.date, '2026-11-08'); // the start date, as on the event's own page
    assert.equal(d.allDay, true);
    assert.equal(d.startTime, null);
    assert.equal(d.endTime, null);
    assert.equal(parseDetail(fixture('event-detail.html')).allDay, false);
  });

  it('reports an event page without a start date as broken', () => {
    assert.throws(() => parseDetail('<div class="summary"><p>No details</p></div>'), /parse_failed/);
  });
});

describe('text helpers', () => {
  it('finds dates in the formats UPSA uses (Ghana time = UTC)', () => {
    assert.equal(findDate('Date: Sunday, 8th November, 2026'), '2026-11-08');
    assert.equal(findDate('November 8, 2026'), '2026-11-08');
    assert.equal(findDate('by 08/11/2026'), '2026-11-08');
    assert.equal(findDate('2027-03-31'), '2027-03-31');
    assert.equal(findDate('31st February 2027'), null);
    assert.equal(findDate('no date here'), null);
  });

  it('strips scripts and markup from HTML', () => {
    assert.equal(htmlToText('<p>Hello <b>students</b></p><script>alert(1)</script><p>Second</p>'), 'Hello students\nSecond');
  });

  it('only allows https pages on upsa.edu.gh', () => {
    assert.doesNotThrow(() => assertAllowed('https://upsa.edu.gh/events/'));
    assert.throws(() => assertAllowed('http://upsa.edu.gh/'), /Blocked/);
    assert.throws(() => assertAllowed('https://upsa.edu.gh.evil.example/'), /Blocked/);
  });
});
