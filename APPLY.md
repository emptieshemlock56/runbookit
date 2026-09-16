# runbookIT.wiki — applying the new look

Two files drop in with no JS changes:

- `styles.css` → replace `public/styles.css`
- `index.html` → replace `public/index.html`
- `favicon.svg` → put in `public/`

That alone gets you the cream palette, serif article titles, dark code blocks and the
restyled sidebar, cards, editor, comments, modal and revision rows, because every
existing `hs-*` class name is preserved.

The four additions from mockup **2a** need small edits in `public/app.js`. Each is
independent — apply the ones you want.

## 1. Wordmark (required, or the header still says howtosysadmin)

In `renderNav()`, replace the brand block with:

```js
<div class="hs-brand" onclick="HS.goHome()">
  <span class="p1">runbook</span><span class="p2">IT</span><span class="p3">.wiki</span>
</div>
```

Also change the search placeholder to `Search ${STATE.index.length} how-tos`.

## 2. Trust bar on the article page

In `renderArticle()`, replace the `hs-meta-row` + `hs-article-actions` blocks with:

```js
<div class="hs-trustbar">
  <span class="fresh">Updated ${timeAgo(a.updatedAt)}</span>
  <span class="sep">|</span><span>${(a.revisions||[]).length} revision${(a.revisions||[]).length===1?'':'s'}</span>
  <span class="sep">|</span><span>${contributorCount(a)} contributor${contributorCount(a)===1?'':'s'}</span>
  <span class="sep">|</span><span>by ${escAttr(a.updatedBy)}</span>
  <span class="spacer">
    ${editControl}
    <button class="ghost" onclick="HS.toggleRevisions();return false;">History</button>
    ${isAdmin() ? `<button class="ghost" onclick="HS.toggleLock()">${a.locked?'Unlock':'Lock'}</button>` : ''}
  </span>
</div>
<div class="hs-openline">Anyone with a free account can edit. Every change is kept and can be restored.</div>
```

`contributorCount` already exists in the file (the helper above `renderStatusBar`).

## 3. "On this page" rail

Headings need ids. In `mdToHtml`, when emitting an `<h2>`, add a slug id:

```js
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
// ...
out += `<h2 id="${slug(text)}">${text}</h2>`;
```

Then add this renderer and call it from `render()` when the view is an article,
placing it after the `hs-main` element inside `hs-layout`, and adding the
`with-rail` class to that `hs-layout` element:

```js
function renderToc(a){
  const heads = (a.body.match(/^##\s+(.+)$/gm)||[]).map(h=>h.replace(/^##\s+/,''));
  if(heads.length < 2) return '';
  return `<div class="hs-toc"><div class="hs-toc-inner">
    <h4>On this page</h4>
    <div class="hs-toc-list">
      ${heads.map(h=>`<a href="#${slug(h)}">${escAttr(h)}</a>`).join('')}
    </div>
  </div></div>`;
}
```

The rail hides itself under 1000px wide, so mobile is unaffected.

## 4. Related how-tos

At the end of `renderArticle()`, before `renderComments()`:

```js
function renderRelated(a){
  const rel = STATE.index.filter(x => x.category===a.category && x.slug!==a.slug).slice(0,3);
  if(!rel.length) return '';
  return `<div class="hs-related"><h4>Related how-tos</h4>
    ${rel.map(r=>`<div class="hs-related-row">
      <a href="#" onclick="HS.openArticle('${r.slug}');return false;">${escAttr(r.title)}</a>
      <span>${timeAgo(r.updatedAt)}</span>
    </div>`).join('')}
  </div>`;
}
```

## 5. Smaller touches

- **First-visit line** on the home page — inside `renderHome()`, after `hs-list-head`:
  `<div class="hs-firstvisit">New here? Every page is written and corrected by working sysadmins.</div>`
- **Revision history** — give the newest row `class="hs-rev-item current"` and wrap the
  View/Diff/Restore buttons in `<span class="hs-rev-actions">` to get the styled row from 2d.
- **Editor tabs** (Write / Preview) — wrap in `<div class="hs-tabs">` and put `class="active"`
  on the current one; the CSS is already there.
- **Edit summary field** — a plain `<input>` with an `hs-field-label` above it; you'll need a
  column on the revisions table to store it.

## Colors

Everything comes from the CSS variables at the top of `styles.css`. The accent is
`--accent: #b5651d`; code blocks are deliberately dark (`--code-bg`) so they stand out
against the cream page.
