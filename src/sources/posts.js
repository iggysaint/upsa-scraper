// Announcements, news and opinions from the UPSA website's official
// WordPress API (preferred over page scraping, CLAUDE.md §6.1), plus the
// hostel notices and fee deadlines filtered from those posts.
import { fetchJson, pause } from '../http.js';
import { decodeTitle, detectCategory, findDate, htmlToText, isFeeRelated, isHostelRelated } from '../text.js';

const API = 'https://upsa.edu.gh/wp-json/wp/v2/posts';
// WordPress category ids on upsa.edu.gh (checked 2026-11-23).
export const CATEGORY = { announcement: 5, news: 1, opinions: 47, hidden: 1011 };
const PER_PAGE = 20;

export const postsUrl = (categoryId) =>
  `${API}?categories=${categoryId}&categories_exclude=${CATEGORY.hidden}&per_page=${PER_PAGE}&orderby=date&order=desc&_embed=wp:featuredmedia`;

// A WordPress post → the fields UNIFY stores. publishedAt is the website's
// own publication time (GMT, which is Ghana time).
export function toItem(post, category) {
  const media = post._embedded?.['wp:featuredmedia']?.[0];
  const imageUrl = typeof media?.source_url === 'string' && media.source_url.startsWith('https://') ? media.source_url : null;
  const title = decodeTitle(post.title?.rendered ?? '');
  return {
    sourceUrl: post.link,
    title,
    body: htmlToText(post.content?.rendered ?? ''),
    category: category ?? detectCategory(title),
    imageUrl,
    publishedAt: post.date_gmt ? `${post.date_gmt}Z` : null,
  };
}

// Throws if the API answers with something that isn't a list of posts, so a
// broken response is reported as a failure, never as "nothing new".
export function parsePosts(json, category) {
  if (!Array.isArray(json)) throw new Error('parse_failed: posts API did not return a list');
  return json
    .filter((p) => p && typeof p.link === 'string' && p.title?.rendered && p.status !== 'private')
    .map((p) => toItem(p, category));
}

export async function fetchPosts() {
  const announcements = parsePosts(await fetchJson(postsUrl(CATEGORY.announcement)));
  await pause(800);
  const news = parsePosts(await fetchJson(postsUrl(CATEGORY.news)), 'articles');
  await pause(800);
  const opinions = parsePosts(await fetchJson(postsUrl(CATEGORY.opinions)), 'articles');
  return { announcements, news, opinions };
}

// The UNIFY "announcements" feed: announcements, news and opinions together
// (as before). The API drops repeats of the same page.
export const announcementItems = ({ announcements, news, opinions }) => [...announcements, ...news, ...opinions];

export const hostelItems = ({ announcements, news }) =>
  [...announcements, ...news]
    .filter((p) => isHostelRelated(p.title))
    .map(({ sourceUrl, title, body, imageUrl, publishedAt }) => ({ sourceUrl, title, body, imageUrl, publishedAt }));

// Fee deadlines become drafts in UNIFY; staff check the date before
// publishing, so the first date found in the text is only a suggestion.
export const feeItems = ({ announcements }) =>
  announcements
    .filter((p) => isFeeRelated(p.title))
    .map((p) => ({ sourceUrl: p.sourceUrl, title: p.title, date: findDate(`${p.title}\n${p.body}`) }));
