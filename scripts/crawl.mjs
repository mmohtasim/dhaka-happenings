#!/usr/bin/env node
// ponytail: keyword + date-cue heuristics, not NLP — "he said today" can false-positive.
// No LLM API key on this machine, so the precision pass happens outside this script:
// after crawling, a reviewed keep/drop curation is applied to public/events.json before pushing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'public', 'events.json');
const UA = 'Mozilla/5.0 (compatible; DhakaHappening/0.1; local crawler)';

const FEEDS = [
  { name: 'The Daily Star', url: 'https://www.thedailystar.net/rss.xml', kind: 'paper' },
  { name: 'Dhaka Tribune', url: 'https://www.dhakatribune.com/feed/', kind: 'paper' },
  { name: 'Prothom Alo (EN)', url: 'https://en.prothomalo.com/feed', kind: 'paper' },
  { name: 'The Business Standard', url: 'https://www.tbsnews.net/rss.xml', kind: 'paper' },
  { name: 'Google News · Dhaka events', url: 'https://news.google.com/rss/search?q=Dhaka+events+today+OR+tomorrow+when:2d&hl=en&gl=BD&ceid=BD:en', kind: 'search' },
  { name: 'Google News · Dhaka shows', url: 'https://news.google.com/rss/search?q=Dhaka+concert+OR+exhibition+OR+festival+when:2d&hl=en&gl=BD&ceid=BD:en', kind: 'search' },
];

// things people can attend. Deliberately excludes news-report verbs (launch, celebrate, award, rally, procession) —
// stories *about* those kept flooding the list; ponytail: keyword heuristics, an LLM pass is the upgrade path.
const KEYWORDS = /\b(concert|festival|exhibit\w*|fair\b|carnival|jatra|theatr(?:e|er)s?\b|drama|recital|gig\b|open mic|film\b|movie|premiere|screening|documentary|book fair|food fest\w*|expo\b|summit|conference|seminar|symposium|workshop|hackathon|meetup|competition|contest|olympiad|tournament|match\b|derby|marathon|walkathon|parade|fireworks|light show|drone show|fashion week|inaugurat\w*|victory day|eid|mela|bijoy|puja|art\b|cultur\w*)\b/i;

const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
  }
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  return named[e.toLowerCase()] ?? ' ';
});
const text = s => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  const items = [];
  for (const m of String(xml).replace(/^\uFEFF/, '').matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const grab = tag => {
      const t = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
      return t ? t[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    const title = text(grab('title'));
    const link = grab('link').replace(/\s+/g, '');
    const summary = text(grab('description'));
    // feeds embed junk (emails, promo blocks with stray dates, raw CSS) in descriptions — better no summary than junk
    if (title && link) items.push({ title, link, summary: /[{]|class=|@/.test(summary) ? '' : summary, pub: grab('pubDate') });
  }
  return items;
}

async function fetchOne(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text());
    return { feed, items, error: items.length ? null : 'no <item> found — feed changed?' };
  } catch (e) {
    return { feed, items: [], error: String(e.cause?.code || e.message || e) };
  }
}

// Dhaka-local date parts, offset days from now (survives midnight rollover between cycles)
const partsAt = offset => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' })
    .formatToParts(new Date(Date.now() + offset * 86400000));
  const g = t => p.find(x => x.type === t)?.value ?? '';
  return { wd: g('weekday'), d: g('day'), mo: g('month') };
};

function buildCues() {
  const make = (offset, word) => {
    const { wd, d, mo } = partsAt(offset);
    const short = mo.slice(0, 3);
    const alts = [wd, `${d}\\s+${short}(?:ber)?\\.?`, `${short}(?:ber)?\\.?\\s+${d}`, word];
    if (mo !== short) alts.push(`${d}\\s+${mo}`, `${mo}\\s+${d}`);
    return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i');
  };
  return { today: make(0, 'today'), tomorrow: make(1, 'tomorrow') };
}

function classify(item, cues) {
  const t = `${item.title} ${item.summary}`;
  return { cue: cues.today.test(t) ? 'today' : cues.tomorrow.test(t) ? 'tomorrow' : '', kw: KEYWORDS.test(t) };
}

// search feeds dedupe on headline (Google News titles end " - Source"); papers on link base
const keyOf = (feed, it) => feed.kind === 'search'
  ? it.title.replace(/ - [^-]+$/, '').toLowerCase().replace(/\W+/g, ' ').trim()
  : it.link.split(/[?#]/)[0].replace(/\/+$/, '');

async function cycle(state) {
  const cues = buildCues();
  const results = await Promise.all(FEEDS.map(fetchOne));
  for (const r of results) {
    const prev = state.sources.get(r.feed.name);
    state.sources.set(r.feed.name, {
      name: r.feed.name, url: r.feed.url, ok: !r.error, items: r.items.length,
      error: r.error ?? null,
      lastOkAt: r.error ? prev?.lastOkAt ?? null : new Date().toISOString(),
    });
    for (const it of r.items) {
      const pubMs = it.pub ? Date.parse(it.pub) : NaN;
      if (Number.isFinite(pubMs) && Date.now() - pubMs > 3 * 86400000) continue; // stale resurfaced stories aren't tomorrow's events
      const k = keyOf(r.feed, it);
      if (k && !state.seen.has(k)) state.seen.set(k, { item: it, source: r.feed.name, kind: r.feed.kind, firstSeenAt: new Date().toISOString() });
    }
  }

  // ponytail: fixed 600-entry session cache, oldest evicted — a day-spanning persistent store is the upgrade path
  let all = [...state.seen.entries()];
  if (all.length > 600) {
    all.sort((a, b) => (a[1].firstSeenAt < b[1].firstSeenAt ? -1 : 1));
    for (const [k] of all.slice(0, all.length - 600)) state.seen.delete(k);
  }

  const buckets = { today: [], tomorrow: [], noDate: [] };
  for (const [, e] of state.seen) {
    // ponytail: papers classify on title only — their RSS summaries carry promo blocks with stray dates; LLM pass if precision matters
    const { cue, kw } = classify({ title: e.item.title, summary: e.kind === 'search' ? e.item.summary : '' }, cues);
    const row = { title: e.item.title, url: e.item.link, source: e.source, summary: e.item.summary, cue, published: e.item.pub || null, firstSeenAt: e.firstSeenAt };
    // no event keyword → not an event, wherever it came from (was: search-feed items skipped this check)
    if (kw && cue === 'today') buckets.today.push(row);
    else if (kw && cue === 'tomorrow') buckets.tomorrow.push(row);
    else if (kw) buckets.noDate.push(row);
  }
  buckets.noDate.sort((a, b) => (String(a.published) < String(b.published) ? 1 : -1)).splice(120);

  const data = { generatedAt: new Date().toISOString(), crawling: state.meta, sources: [...state.sources.values()], ...buckets };
  writeFileSync(OUT, JSON.stringify(data, null, 2));
  return data;
}

const log = msg => console.log(`[${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}] ${msg}`);

function selftest() {
  const cues = buildCues();
  const c = t => classify({ title: t, summary: '' }, cues);
  const tp = partsAt(1);
  const cases = [
    ['Big concert at Army Stadium tomorrow evening', 'tomorrow'],
    ['Art exhibition opens today at Drik Gallery', 'today'],
    [`Seminar on ${tp.d} ${tp.mo}`, 'tomorrow'],
    [`Story filed ${tp.wd}`, 'tomorrow'],
    ['Bangladesh won the final yesterday', ''],
    ['Routine politics story from the capital', ''],
  ];
  for (const [input, want] of cases) {
    const got = c(input).cue;
    if (got !== want) { console.error(`FAIL: "${input}" → "${got}", want "${want}"`); process.exit(1); }
  }
  if (!c('Bangladesh won the match yesterday').kw) { console.error('FAIL: keyword missed'); process.exit(1); }
  for (const bad of ['Gopalganj DC, SP transferred after armed procession, vandalism', 'Shahjalal Islami Bank wins Gold Award', 'CSI launches new power station models in Dhaka']) {
    if (c(bad).kw) { console.error(`FAIL: news story passed keyword filter: "${bad}"`); process.exit(1); }
  }
  const pf = parseFeed('<rss><channel><item><title>T</title><link>http://x/y</link><description><![CDATA[a@b.com 16 November 2026 Editor\'s Pick]]></description></item></channel></rss>');
  if (pf.length !== 1 || pf[0].summary !== '') { console.error('FAIL: junk summary not dropped'); process.exit(1); }
  console.log('selftest ok —', partsAt(0).wd, partsAt(0).d, partsAt(0).mo, '/', tp.wd, tp.d, tp.mo);
}

const argv = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const once = process.argv.includes('--once');
const hours = Number(argv.hours) || 6;
const intervalMinutes = Number(argv['interval-min']) || 10;

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }

const state = {
  sources: new Map(),
  seen: new Map(),
  meta: { startedAt: new Date().toISOString(), hours: once ? 0 : hours, intervalMinutes, cycles: 0 },
};
mkdirSync(dirname(OUT), { recursive: true });
log(`start: ${once ? 'single pass' : `${hours}h @ ${intervalMinutes}min`}, ${FEEDS.length} feeds`);

while (true) {
  state.meta.cycles++;
  const t0 = Date.now();
  let data = null;
  try { data = await cycle(state); } catch (e) { log(`cycle failed: ${e}`); }
  if (data) log(`cycle ${state.meta.cycles}: today=${data.today.length} tomorrow=${data.tomorrow.length} noDate=${data.noDate.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (once) break;
  if ((Date.now() - Date.parse(state.meta.startedAt)) / 3.6e6 >= hours) { log('time up'); break; }
  await new Promise(r => setTimeout(r, intervalMinutes * 60000));
}
