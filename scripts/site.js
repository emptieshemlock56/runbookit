#!/usr/bin/env node
// Command-line access to the live wiki, for writing pages from Claude Code.
//
//   node scripts/site.js categories              list category slugs
//   node scripts/site.js list                    every article: slug | category | title
//   node scripts/site.js search <words...>       find existing articles on a topic
//   node scripts/site.js get <slug>              print an article as a page file (to edit + republish)
//   node scripts/site.js check <file.md>         lint a page file against the site's markdown support
//   node scripts/site.js publish <file.md> [--review]
//                                                create the article, or update it if the file has a slug;
//                                                --review sends it to the admin review queue instead
//
// Page files are markdown with a small header:
//   ---
//   title: How to build an IPsec VPN between AWS and a FortiGate
//   category: networking
//   tags: aws, fortigate, ipsec, vpn
//   slug: (filled in automatically after the first publish)
//   ---
//
// Reads SITE_URL and PUBLISH_TOKEN from the environment or .env.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const SITE = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');

async function api(method, p, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    if (!process.env.PUBLISH_TOKEN) die('PUBLISH_TOKEN is not set in .env.');
    headers.Authorization = `Bearer ${process.env.PUBLISH_TOKEN}`;
  }
  let res;
  try {
    res = await fetch(SITE + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    die(`Could not reach ${SITE}: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) die(`${method} ${p} failed (${res.status}): ${(data && data.error) || res.statusText}`);
  return data;
}
function die(msg) { console.error('Error: ' + msg); process.exit(1); }

function parsePage(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) die('Page file must start with a --- header block (title, category, tags).');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2].trim() + '\n' };
}
function formatPage(meta, body) {
  const head = ['title', 'category', 'tags', 'slug'].filter(k => meta[k]).map(k => `${k}: ${meta[k]}`).join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

// Things public/app.js mdToHtml doesn't render. Returns a list of warnings.
function lint(body) {
  const warnings = [];
  let inCode = false;
  body.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (line.trim().startsWith('```')) { inCode = !inCode; return; }
    if (inCode) return;
    if (/^\s*\|.*\|\s*$/.test(line)) warnings.push(`line ${n}: tables are not supported`);
    if (/^\s+([-*]|\d+\.)\s+/.test(line)) warnings.push(`line ${n}: nested/indented list items render as plain paragraphs`);
    if (/^\s*\*\s+/.test(line)) warnings.push(`line ${n}: use "- " for bullets, not "* "`);
    if (/^#{4,}\s/.test(line)) warnings.push(`line ${n}: only #, ## and ### headings are supported`);
    if (/<\/?[a-z][^>]*>/i.test(line.replace(/`[^`]*`/g, '').replace(/<[A-Z0-9_]+>/g, ''))) warnings.push(`line ${n}: raw HTML is shown as text`);
    if (/!\[[^\]]*\]\(/.test(line)) warnings.push(`line ${n}: images are stripped when publishing`);
    if (/\]\((?!https?:\/\/)[^)]+\)/.test(line)) warnings.push(`line ${n}: non-http(s) links are stripped when publishing`);
  });
  if (inCode) warnings.push('unclosed ``` code block');
  return warnings;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'categories') {
    const { categories } = await api('GET', '/categories');
    for (const c of categories) console.log(`${c.slug}\t${c.label}`);
  } else if (cmd === 'list') {
    const { articles } = await api('GET', '/articles');
    for (const a of articles) console.log(`${a.slug} | ${a.category} | ${a.title}`);
    console.log(`(${articles.length} articles on ${SITE})`);
  } else if (cmd === 'search') {
    const words = args.join(' ').toLowerCase().match(/[a-z0-9]{2,}/g) || die('Give some search words.');
    // The site's own search is phrase-based, so also score the index by individual words.
    const { articles } = await api('GET', '/articles');
    const scored = articles.map(a => {
      const hay = `${a.title} ${a.tags.join(' ')} ${a.excerpt}`.toLowerCase();
      return { a, score: words.filter(w => hay.includes(w)).length };
    }).filter(x => x.score > 0).sort((x, y) => y.score - x.score).slice(0, 10);
    const { results } = await api('GET', '/search?q=' + encodeURIComponent(args.join(' ')));
    const seen = new Set();
    for (const a of [...results, ...scored.map(x => x.a)]) {
      if (seen.has(a.slug)) continue;
      seen.add(a.slug);
      console.log(`${a.slug} | ${a.category} | ${a.title}\n    ${a.excerpt}`);
    }
    if (!seen.size) console.log('No matching articles.');
  } else if (cmd === 'get') {
    if (!args[0]) die('Usage: get <slug>');
    const { article: a } = await api('GET', '/articles/' + encodeURIComponent(args[0]));
    process.stdout.write(formatPage({ title: a.title, category: a.category, tags: a.tags.join(', '), slug: a.slug }, a.body));
  } else if (cmd === 'check' || cmd === 'publish') {
    const file = args.find(a => !a.startsWith('--')) || die(`Usage: ${cmd} <file.md>`);
    const { meta, body } = parsePage(fs.readFileSync(file, 'utf8'));
    if (!meta.title) die('Header is missing "title".');
    if (!meta.category) die('Header is missing "category" (run: node scripts/site.js categories).');
    const warnings = lint(body);
    for (const w of warnings) console.log('warning: ' + w);
    if (cmd === 'check') return console.log(warnings.length ? `${warnings.length} warning(s).` : 'Looks good.');

    const { categories } = await api('GET', '/categories');
    const known = categories.some(c => c.slug === meta.category);
    const payload = {
      title: meta.title,
      category: known ? meta.category : null,
      newCategoryLabel: known ? undefined : meta.category,
      tags: (meta.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      body,
      slug: meta.slug || undefined,
      mode: args.includes('--review') ? 'review' : 'publish',
    };
    if (!known) console.log(`Category "${meta.category}" doesn't exist yet - it will be created.`);
    const out = await api('POST', '/publish', payload);
    if (out.pending) return console.log(`Sent to the review queue (#${out.pendingId}) on ${SITE}.`);
    if (!meta.slug) fs.writeFileSync(file, formatPage({ ...meta, slug: out.slug }, body)); // later publishes update instead of duplicating
    console.log(`${out.updated ? 'Updated' : 'Published'} "${meta.title}" (slug: ${out.slug}) on ${SITE}`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
main();
