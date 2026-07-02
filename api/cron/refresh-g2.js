// GET/POST /api/cron/refresh-g2
//
// Pulls the latest G2 reviews and adds ONLY genuinely-new ones, using the same
// per-review upsert path as everything else (addNewReviews -> HSETNX). It never
// reads the full list and rewrites it, so it can run at the same instant as a
// browser edit without clobbering anything: HSETNX only writes a review's field
// if that id doesn't already exist, so existing (possibly edited) reviews are
// left completely untouched.
//
// Scheduled by vercel.json (Vercel Cron issues a GET). If CRON_SECRET is set, the
// request must carry `Authorization: Bearer <CRON_SECRET>` — Vercel Cron sends this
// automatically. You can also POST { reviews: [...] } to push reviews from an
// external scraper/integration through the same add-new-only path.

import { storageConfigured, ensureSeeded, addNewReviews, readBody } from '../_store.js';

// TODO: wire up the real G2 source (scrape / API / MCP connector). Return an array
// of review objects shaped like:
//   { id, platform: 'G2', reviewer, rating, date, text }
// The `id` MUST be stable and unique per review (e.g. G2's own review id) so that
// re-running the cron never duplicates a review and never overwrites edits.
async function fetchLatestG2Reviews() {
  return [];
}

function normalize(list) {
  return (Array.isArray(list) ? list : [])
    .filter(r => r && r.id && r.text)
    .map(r => ({
      reply: '',
      status: 'needs_reply',
      ...r,
      id: String(r.id),
      platform: r.platform || 'G2',
      rating: Number(r.rating) || 5
    }));
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  if (!storageConfigured()) {
    res.status(503).json({ error: 'Storage not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN).' });
    return;
  }

  try {
    await ensureSeeded();

    let incoming = await fetchLatestG2Reviews();
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (Array.isArray(body.reviews)) incoming = incoming.concat(body.reviews);
    }

    const added = await addNewReviews(normalize(incoming));
    res.status(200).json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Cron failed' });
  }
}
