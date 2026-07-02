// GET  /api/reviews  -> { reviews, settings, activityLog }
//
// POST /api/reviews  <- targeted operations (never a whole-array rewrite):
//   {
//     upsert?:  Review | Review[],   // add or edit specific reviews (HSET per field)
//     delete?:  string | string[],   // remove specific reviews by id (HDEL)
//     settings?: {...},              // replace the shared settings blob
//     logEntry?: { text }            // append one activity entry (LPUSH)
//   }
//   ("reviews" is accepted as a legacy alias for "upsert" so an older cached client
//    still persists its edits — it just won't delete anything.)
//   -> the full reconstructed { reviews, settings, activityLog }
//
// Because every write touches only the specific review fields it names, two writes
// to different reviews (e.g. the G2 cron and a browser edit) can't clobber each other.

import {
  storageConfigured,
  getFullState,
  upsertReviews,
  deleteReviews,
  saveSettings,
  appendActivity,
  readBody
} from './_store.js';

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

export default async function handler(req, res) {
  if (!storageConfigured()) {
    res.status(503).json({
      error: 'Shared storage is not configured. Add a Vercel KV (Upstash Redis) integration to this project and redeploy — it sets KV_REST_API_URL and KV_REST_API_TOKEN automatically.'
    });
    return;
  }

  try {
    if (req.method === 'GET') {
      res.status(200).json(await getFullState());
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const upsert = toArray(body.upsert !== undefined ? body.upsert : body.reviews).filter(r => r && r.id);
      const del = toArray(body.delete).map(String).filter(Boolean);

      if (body.settings) await saveSettings(body.settings);
      if (upsert.length) await upsertReviews(upsert);
      if (del.length) await deleteReviews(del);
      if (body.logEntry && typeof body.logEntry.text === 'string' && body.logEntry.text.trim()) {
        await appendActivity(body.logEntry.text);
      }

      res.status(200).json(await getFullState());
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
