# Personalized Weekly Briefing

Dashboard for the personalized ChatGPT Work daily and weekly briefings. The
sidebar lists every briefing; selecting one loads its stories as cards on the
right, and the published briefing stays one click away as a standalone page.

**Live site:** deployed on Vercel from `main`.

## Layout

```
public/
  index.html            dashboard shell (sidebar + card pane)
  assets/
    styles.css          design tokens, layout, card styles (light + dark)
    app.js              routing, search, filters, card rendering
    favicon.svg
  briefings/            one static HTML page per briefing (published as-is)
  data/briefings.json   generated manifest the dashboard renders from
scripts/
  build.mjs             normalizes briefings, writes the manifest
  serve.mjs             tiny static server for local preview
```

## Adding a briefing

1. Drop the downloaded HTML into `public/briefings/`. Raw ChatGPT exports work
   as-is — the build unwraps the `srcdoc` viewer wrapper, removes the ChatGPT
   host bridge script, adds `id="story-N"` anchors, and renames the file to
   `YYYY-MM-DD-{daily|weekly}.html`. The date may be in the filename as
   `2026-09-11` or `20260911`; `weekly`/`friday` in the name marks it weekly.
2. Run `npm run build`.
3. Commit both the briefing page and the regenerated
   `public/data/briefings.json`, then push. Vercel deploys on push and reruns
   the build.

## Local preview

```bash
npm run dev     # builds, then serves public/ at http://localhost:4173
npm run build   # regenerate briefings + manifest only
```

No dependencies and no framework — Node 20+ for the build, plain HTML/CSS/JS
for the site.

## How the cards are built

Each briefing is hand-authored HTML and the markup differs between editions, so
`scripts/build.mjs` parses shapes that have held across every edition rather
than one fixed class scheme: an `<article>` per story, an `<h3>` headline, a
summary paragraph, disclosure sections labelled "What changed" / "Why this
matters" / "Try this" / "Sources", the "at a glance" strip, and the
"worth watching" footer. It also lifts each story's inline SVG illustration
into the card. A briefing that parses to zero stories is reported as a warning
at build time and still ships as a full-page link.
