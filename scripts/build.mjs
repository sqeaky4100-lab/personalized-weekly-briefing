#!/usr/bin/env node
/**
 * Build step for the Personalized Weekly Briefing dashboard.
 *
 * 1. Normalizes every briefing in public/briefings:
 *    - unwraps the ChatGPT "visualize standalone" wrapper (iframe srcdoc) so the
 *      file is a real standalone page,
 *    - strips the ChatGPT host bridge script, which has no host to talk to here,
 *    - gives each story an id so the dashboard can deep-link into it,
 *    - renames raw exports to YYYY-MM-DD-{daily|weekly}.html.
 * 2. Writes public/data/briefings.json, the manifest the dashboard renders from.
 *
 * Each briefing is hand-authored HTML, so the markup differs between editions.
 * Parsing therefore works off shapes that have held across every edition so far
 * (an <article> per story, an <h3> headline, a summary paragraph, disclosure
 * sections labelled "Why this matters"/"Try this"/"Sources") rather than one
 * fixed class naming scheme.
 *
 * Adding a briefing: drop the downloaded HTML into public/briefings and run
 * `npm run build`. No other file needs to change.
 */
import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const briefDir = join(root, 'public', 'briefings');
const manifestPath = join(root, 'public', 'data', 'briefings.json');

const ACCENTS = ['blue', 'teal', 'amber', 'purple', 'coral'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/* ---------------------------------------------------------------- helpers */

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function toText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

const attr = (attrs, name) => decodeEntities((String(attrs).match(new RegExp(`${name}="([^"]*)"`, 'i')) ?? [])[1] ?? '');
const firstMatch = (html, re) => (String(html).match(re) ?? [])[1] ?? '';
const allMatches = (html, re) => [...String(html).matchAll(re)];
const unique = (values) => [...new Set(values.filter(Boolean))];

/** Depth-aware element lookup: every `tagPattern` element whose attributes match. */
function findWhere(html, tagPattern, matches) {
  const source = String(html);
  const openTag = new RegExp(`<(${tagPattern})\\b([^>]*)>`, 'gi');
  const results = [];
  let open;
  while ((open = openTag.exec(source)) !== null) {
    const [tag, attrs] = [open[1], open[2] ?? ''];
    if (matches && !matches(attrs)) continue;
    const walker = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}\\s*>`, 'gi');
    walker.lastIndex = openTag.lastIndex;
    let depth = 1;
    let step;
    while (depth > 0 && (step = walker.exec(source)) !== null) {
      depth += step[0].startsWith('</') ? -1 : 1;
    }
    if (depth !== 0) continue;
    results.push({
      tag,
      attrs,
      inner: source.slice(openTag.lastIndex, step.index),
      outer: source.slice(open.index, walker.lastIndex),
    });
  }
  return results;
}

const findByClass = (html, tagPattern, classPattern) =>
  findWhere(html, tagPattern, classPattern ? (attrs) => classPattern.test(attr(attrs, 'class')) : null);

/** First <b>/<strong> label plus its following <span>/<small> note. */
function labelledPair(html) {
  const label = toText(firstMatch(html, /<(?:strong|b)(?=[\\s>])[^>]*>([\s\S]*?)<\/(?:strong|b)>/i));
  const notes = allMatches(html, /<(?:span|small)(\s[^>]*)?>([\s\S]*?)<\/(?:span|small)>/gi)
    .map((m) => toText(m[2]))
    .filter((text) => text.length > 2 && !/^\d+$/.test(text));
  return { label, note: notes[0] ?? '' };
}

/* -------------------------------------------------------------- normalize */

/** ChatGPT exports wrap the real document in an iframe srcdoc attribute. */
function unwrapExport(raw) {
  if (!/data-visualize-standalone/.test(raw)) return raw;
  const match = raw.match(/<iframe[^>]*?\sdata-srcdoc="([\s\S]*?)"[\s>]/) ??
    raw.match(/<iframe[^>]*?\ssrcdoc="([\s\S]*?)"[\s>]/);
  if (!match) return raw;
  const inner = decodeEntities(match[1]);
  return /<html/i.test(inner) ? unwrapExport(inner) : raw;
}

/** Drop the ChatGPT widget host bridge and give each story a linkable id. */
function cleanDocument(html) {
  let out = html
    .replace(/<script type="application\/json" id="codex-visualization-widget-state">[\s\S]*?<\/script>\s*/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, (block) =>
      /codex-visualization-widget-state|openai:set_globals|widget-state-write/.test(block) ? '' : block);

  let index = 0;
  return out.replace(/<article(?![^>]*\sid=)/g, () => `<article id="story-${++index}"`);
}

function describeFile(name) {
  const kind = /weekly|friday/i.test(name) ? 'weekly' : 'daily';
  const date = name.match(/(\d{4})-(\d{2})-(\d{2})/) ?? name.match(/(\d{4})(\d{2})(\d{2})/);
  if (!date) return null;
  const [, year, month, day] = date;
  return { kind, date: `${year}-${month}-${day}`, slug: `${kind}-${year}-${month}-${day}` };
}

function formatDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return {
    weekday: new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    label: `${MONTHS[month - 1]} ${day}, ${year}`,
    short: `${MONTHS[month - 1].slice(0, 3)} ${day}`,
  };
}

/** Keep the briefing's own illustration, minus anything executable. */
function sanitizeArt(svg) {
  if (!svg) return '';
  const cleaned = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\s(?:width|height)="[^"]*"/gi, '');
  return cleaned.length > 12000 ? '' : cleaned;
}

/* ------------------------------------------------------------------ parse */

const PROMPT_BOX = /\b(copy-block|copy-row|copy-box|prompt)\b/;

/** The copyable prompt: a data-copy attribute, a <code> block, or a copy box. */
function extractPrompt(html) {
  const fromAttribute = attr(html, 'data-copy');
  if (fromAttribute) return fromAttribute;
  const fromCode = toText(firstMatch(html, /<code[^>]*>([\s\S]*?)<\/code>/i));
  if (fromCode) return fromCode;
  const box = findByClass(html, 'div|p|blockquote', PROMPT_BOX)[0];
  return box ? toText(box.inner.replace(/<button[\s\S]*?<\/button>/gi, ' ')) : '';
}

/** Section prose only: button labels and copyable prompts render separately. */
function sectionBody(html) {
  let out = String(html)
    .replace(/<button[\s\S]*?<\/button>/gi, ' ')
    .replace(/<code[\s\S]*?<\/code>/gi, ' ');
  for (const box of findByClass(out, 'div|blockquote', PROMPT_BOX)) out = out.replace(box.outer, ' ');
  return toText(out);
}

/** Disclosure sections: <details> in most editions, tab panels in others. */
function parseSections(articleHtml) {
  const details = findByClass(articleHtml, 'details', null).map((block) => ({
    label: toText(firstMatch(block.inner, /<summary[^>]*>([\s\S]*?)<\/summary>/i)),
    body: sectionBody(block.inner.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, '')),
    copy: extractPrompt(block.inner),
  }));
  if (details.length) return details;

  const tabs = findByClass(articleHtml, 'div', /\btabs\b/)[0];
  if (tabs) {
    const labels = allMatches(tabs.inner, /<button[^>]*class="tab"[^>]*>([\s\S]*?)<\/button>/gi).map((m) => toText(m[1]));
    const panels = findByClass(tabs.inner, 'div', /\bpanel\b/);
    if (panels.length) {
      return panels.map((panel, index) => ({
        label: labels[index] ?? '',
        body: sectionBody(panel.inner),
        copy: extractPrompt(panel.inner),
      }));
    }
  }

  // Bootstrap-style tabs: role="tab" buttons pointing at role="tabpanel" panels.
  const tabButtons = allMatches(articleHtml, /<button([^>]*role="tab"[^>]*)>([\s\S]*?)<\/button>/gi)
    .map((m) => ({ controls: attr(m[1], 'aria-controls'), label: toText(m[2]) }));
  const panels = findWhere(articleHtml, 'div|section', (attrs) => /role="tabpanel"/.test(attrs));
  if (!panels.length) return [];
  return panels.map((panel, index) => {
    const id = attr(panel.attrs, 'id');
    const tab = tabButtons.find((button) => button.controls && button.controls === id) ?? tabButtons[index];
    return { label: tab?.label ?? '', body: sectionBody(panel.inner), copy: extractPrompt(panel.inner) };
  });
}

function parseLinks(articleHtml) {
  const seen = new Map();
  for (const match of allMatches(articleHtml, /<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], 'href');
    if (!/^https?:\/\//.test(href)) continue;
    const label = toText(match[2])
      .replace(/\s*[↗→]\s*$/, '')
      .replace(/^(?:editorial visual|illustration|visual)\s*·\s*/i, '')
      .replace(/^Source:\s*/i, '')
      .trim();
    if (!label || label.length > 70) continue;
    if (/^(illustration|visual|chart|figure|editorial)\b/i.test(label)) continue;
    if (!seen.has(href) || seen.get(href).length > label.length) seen.set(href, label);
  }
  const labels = new Set();
  return [...seen.entries()]
    .filter(([, label]) => !labels.has(label.toLowerCase()) && labels.add(label.toLowerCase()))
    .map(([href, label]) => ({ href, label }))
    .slice(0, 4);
}

function parseStory(article, index) {
  const { attrs, inner } = article;
  const headline = toText(firstMatch(inner, /<h3[^>]*>([\s\S]*?)<\/h3>/i)) ||
    toText(firstMatch(inner, /<h2[^>]*>([\s\S]*?)<\/h2>/i));
  if (!headline) return null;

  const paragraphs = allMatches(inner, /<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi)
    .map((m) => ({ className: attr(m[1] ?? '', 'class'), text: toText(m[2]) }))
    .filter((p) => p.text.length > 40);
  const summary = (paragraphs.find((p) => /summary|dek|deck|lede/.test(p.className)) ??
    paragraphs.find((p) => !/restriction|caption|credit/.test(p.className)))?.text ?? '';

  const chipGroups = findByClass(inner, 'div|p', /\b(chips|story-meta|meta|badges)\b/);
  const chips = unique([
    ...findByClass(inner, 'span', /\b(chip|tag|fresh|when|viz-badge|badge)\b/).map((span) => toText(span.inner)),
    ...chipGroups.flatMap((group) => allMatches(group.inner, /<span(?:\s[^>]*)?>([\s\S]*?)<\/span>/gi).map((m) => toText(m[1]))),
    ...allMatches(inner, /<time[^>]*>([\s\S]*?)<\/time>/gi).map((m) => toText(m[1])),
  ])
    .filter((chip) => chip.length > 1 && chip.length < 46)
    .slice(0, 3);

  const sections = parseSections(inner);
  const pick = (re) => sections.find((section) => re.test(section.label));
  const changed = pick(/what changed|^changed/i);
  const why = pick(/why/i);
  const tryIt = pick(/try|prompt|do this|experiment/i);
  const watchFor = pick(/what to watch|watch for/i);

  const topics = unique((attr(attrs, 'data-topic') || attr(attrs, 'data-tags') || '').toLowerCase().split(/[\s,]+/));
  const isWorld = topics.includes('world') || /\b(world|world snapshot|geopolitic\w*)\b/i.test(chips.join(' '));

  return {
    id: attr(attrs, 'id') || `story-${index + 1}`,
    headline,
    summary,
    chips,
    topics: isWorld ? unique([...topics, 'world']) : topics,
    accent: isWorld ? 'coral' : ACCENTS[index % ACCENTS.length],
    whatChanged: changed?.body ?? '',
    whyItMatters: why?.body ?? '',
    tryThis: (tryIt?.body ?? '').replace(/\s*Copy(?: prompt)?\s*$/i, ''),
    prompt: tryIt?.copy ?? '',
    watchFor: watchFor?.body ?? '',
    links: parseLinks(inner),
    art: sanitizeArt(firstMatch(inner, /(<svg[\s\S]*?<\/svg>)/i)),
  };
}

const GLANCE_ITEM = /\b(glance-item|flow-item|time-node|tick|glance-card|glance-node|moment)\b/;

/** A glance entry: a bold label, an optional date, and a short note. */
function glanceItem(html) {
  const label = toText(firstMatch(html, /<(?:strong|b)(?=[\\s>])[^>]*>([\s\S]*?)<\/(?:strong|b)>/i));
  const date = toText(findByClass(html, 'span|small|time', /\b(date|node-date|when)\b/)[0]?.inner ??
    firstMatch(html, /<time[^>]*>([\s\S]*?)<\/time>/i));
  const notes = allMatches(html, /<(?:span|small|p)(\s[^>]*)?>([\s\S]*?)<\/(?:span|small|p)>/gi)
    .map((m) => toText(m[2]))
    .filter((text) => text.length > 2 && text !== label && text !== date && !/^\d+$/.test(text));
  const note = [notes[0], date].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(' · ');
  return { label, note };
}

function parseGlance(html) {
  const candidates = findByClass(html, 'div|section', /\b(glance|timeline|flow-grid|flow|glance-track)\b/)
    .sort((a, b) => a.inner.length - b.inner.length);
  for (const container of candidates) {
    const items = findByClass(container.inner, 'div|li|button|a', GLANCE_ITEM)
      .map((item) => glanceItem(item.inner))
      .filter((pair) => pair.label && pair.label.length < 60 && pair.note && pair.note.length < 120);
    if (items.length >= 2) return items.slice(0, 6);
  }
  return [];
}

function parseWatch(html) {
  const container = findByClass(html, 'footer|aside|section|div', /\bwatch\b/)[0];
  if (!container) return [];
  const items = findByClass(container.inner, 'div|li', /\bwatch-item\b/);
  if (items.length) {
    return items.map((item) => labelledPair(item.inner)).filter((pair) => pair.label);
  }

  // Newer editions mark each signal with a bold lead-in followed by its note.
  const bolded = container.inner.split(/<(?:strong|b)(?=[\\s>])[^>]*>/i).slice(1)
    .map((part) => {
      const [label, ...rest] = part.split(/<\/(?:strong|b)>/i);
      return { label: toText(label).replace(/[:·]\s*$/, ''), note: toText(rest.join('')).slice(0, 420) };
    })
    .filter((item) => item.label && item.label.length < 80 && item.note.length > 20);
  if (bolded.length) return bolded.slice(0, 4);

  const text = toText(container.inner).replace(/^Worth watching\s*[·—-]?\s*/i, '');
  return text.split(/\s+·\s+/).map((part) => {
    const split = part.match(/^([^:]{3,44}):\s*(.+)$/);
    return split ? { label: split[1], note: split[2] } : { label: 'Signal', note: part };
  }).filter((item) => item.note);
}

function parseBriefing(html, file, meta) {
  const header = findByClass(html, 'header', null)[0]?.inner ?? '';
  const title = toText(firstMatch(html, /<title>([\s\S]*?)<\/title>/i));
  const theme = toText(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || title;
  const kicker = toText(findByClass(header, 'p|div|span', /\b(kicker|eyebrow)\b/)[0]?.inner ?? '');
  const headerParagraphs = allMatches(header, /<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi)
    .map((m) => ({ className: attr(m[1] ?? '', 'class'), text: toText(m[2]) }))
    .filter((p) => p.text.length > 60 && !/kicker|eyebrow/.test(p.className));
  const deck = (headerParagraphs.find((p) => /deck|dek|lede|summary/.test(p.className)) ?? headerParagraphs[0])?.text ?? '';

  const main = findByClass(html, 'main', null)[0]?.inner ?? html;
  const stories = findByClass(main, 'article', null)
    .map((article, index) => parseStory(article, index))
    .filter(Boolean);

  const dates = formatDate(meta.date);
  return {
    slug: meta.slug,
    kind: meta.kind,
    date: meta.date,
    weekday: dates.weekday,
    dateLabel: dates.label,
    shortDate: dates.short,
    file: `briefings/${file}`,
    title: title || `${meta.kind === 'weekly' ? 'Weekly' : 'Daily'} Briefing ${dates.short}`,
    theme,
    kicker,
    deck,
    glance: parseGlance(html),
    stories,
    watch: parseWatch(html),
    topics: unique(stories.flatMap((story) => story.topics)),
    storyCount: stories.length,
  };
}

/* ------------------------------------------------------------------- main */

const files = (await readdir(briefDir)).filter((name) => name.endsWith('.html'));
const briefings = [];
const problems = [];

for (const name of files) {
  const meta = describeFile(name);
  if (!meta) {
    problems.push(`${name}: no date in filename (expected YYYY-MM-DD or YYYYMMDD)`);
    continue;
  }
  const original = await readFile(join(briefDir, name), 'utf8');
  const cleaned = cleanDocument(unwrapExport(original));
  if (cleaned !== original) await writeFile(join(briefDir, name), cleaned);

  const target = `${meta.date}-${meta.kind}.html`;
  if (name !== target) {
    await rename(join(briefDir, name), join(briefDir, target));
    console.log(`renamed ${name} -> ${target}`);
  }

  const briefing = parseBriefing(cleaned, target, meta);
  if (!briefing.stories.length) problems.push(`${target}: no story cards found`);
  briefings.push(briefing);
}

briefings.sort((a, b) => b.date.localeCompare(a.date));

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  count: briefings.length,
  briefings,
}, null, 2)}\n`);

// Keep the no-JavaScript fallback in index.html pointing at the real pages.
const indexPath = join(root, 'public', 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
const fallback = briefings.map((brief) =>
  `          <p><a href="${brief.file}">${brief.kind === 'weekly' ? 'Weekly' : 'Daily'} briefing · ` +
  `${brief.dateLabel} — ${brief.theme.replace(/[<>&]/g, ' ')}</a></p>`).join('\n');
const patchedIndex = indexHtml.replace(
  /(<!-- briefing-links:start -->)[\s\S]*?(<!-- briefing-links:end -->)/,
  `$1\n${fallback}\n          $2`
);
if (patchedIndex !== indexHtml) await writeFile(indexPath, patchedIndex);

console.log(`wrote public/data/briefings.json — ${briefings.length} briefing(s), ` +
  `${briefings.reduce((sum, brief) => sum + brief.storyCount, 0)} story cards`);
for (const problem of problems) console.warn(`warning: ${problem}`);
