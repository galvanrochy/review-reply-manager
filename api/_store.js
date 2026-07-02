// Shared storage layer (imported by the API routes; the leading underscore keeps
// Vercel from turning this file into its own endpoint).
//
// Concurrency model — each review is its own field in a Redis hash, so writes to
// different reviews never touch the same value and can't clobber each other:
//
//   reviews:data         HASH   field = reviewId, value = JSON of that one review
//   reviews:settings     STRING JSON of the shared brand-voice settings (low conflict)
//   reviews:activity      LIST   JSON activity entries, newest first (append-only)
//   reviews:initialized  STRING seed marker
//
// Editing/adding a review uses HSET on only that review's field. Deleting uses HDEL.
// The cron adds genuinely-new reviews with HSETNX (never overwrites an existing one).
// Activity is LPUSH + LTRIM — naturally additive, no read-modify-write.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const HASH_KEY = 'reviews:data';
const SETTINGS_KEY = 'reviews:settings';
const ACTIVITY_KEY = 'reviews:activity';
const INIT_KEY = 'reviews:initialized';
const ACTIVITY_MAX = 100;

export const DEFAULT_SETTINGS = { companyName: 'Hire Overseas', signerName: '', toneMode: 'founder' };

// Seed data used only the first time the store is empty. Pulled from the G2 and
// Trustpilot profile pages on 2026-07-02 (neither platform exposes a reply API here).
export const SEED_REVIEWS = [
  { id: 'g2-1', platform: 'G2', reviewer: 'Lindsay G.', rating: 5, date: '2026-06-26',
    text: "Definitely the service. Philip and the team were extremely responsive and proactive throughout the process. They lined up strong candidates quickly, helped screen them, coordinated the take-home exercise, and stayed very hands-on through onboarding. Their pricing was also very reasonable for the quality of support and candidates." },
  { id: 'g2-2', platform: 'G2', reviewer: 'Kurush D.', rating: 5, date: '2026-06-28',
    text: "I really like that Hire Overseas has helped with all our communication, marketing material, and social media, handling everything like go-to-market tasks which our team does not have the bandwidth or specialty for. The quality of the candidates they've provided has been probably the best I've ever seen. The founding team is very responsive to our needs and offers great customer service. Dislike: the pricing is a little bit on the higher side, but it's probably the value that you're getting." },
  { id: 'g2-3', platform: 'G2', reviewer: 'Verified User (Hospital & Health Care)', rating: 5, date: '2026-06-29',
    text: "The white glove service - they are highly communicative, offering a personalized approach. They solved our staffing issues, and we were able to get a highly qualified remote assistant very quickly. We needed a daily bookkeeper and they provided an amazing hire for us." },
  { id: 'g2-4', platform: 'G2', reviewer: 'Verified User (Computer Software)', rating: 5, date: '2026-06-29',
    text: "The hiring process was organized, communication was clear, and the team was responsive. Overall, they've made finding and working with international professionals a smooth and positive experience. Our Customer Success and SEO Specialist was hired through Hire Overseas, and the experience was smooth, transparent, and well-organized from start to finish." },
  { id: 'g2-5', platform: 'G2', reviewer: 'Thomas D.', rating: 5, date: '2026-06-30',
    text: "All of the work is done by Harlan, Philip and their team. There's no upfront investment to see candidates and they get you great matches quickly. Even when we had a candidate that wasn't a good match, we had new interviews lined up and hired a replacement that week." },
  { id: 'g2-6', platform: 'G2', reviewer: 'Jeremiah S.', rating: 5, date: '2026-06-27',
    text: "The smoothness of the process. One call and they immediately understood my needs and got me the right fit. There were no outright downsides. Whenever I had an issue, they immediately responded." },
  { id: 'g2-7', platform: 'G2', reviewer: 'Alisa C.', rating: 5, date: '2026-06-30',
    text: "Harlan is super helpful and responsive, empathetic and goes the extra mile. Dislike: it can be hard to get used to overseas employees." },
  { id: 'tp-6a43bacca66ad51235f02e9c', platform: 'Trustpilot', reviewer: 'Alisa Cohn', rating: 5, date: '2026-07-01',
    text: "I've been working with Harlan at HireOverseas for over 1 year and he's always so helpful and supportive. If there are issues he gets involved and helps to find solutions and he and the team go above and beyond. I've been working with the VA they found for me for over 1 year who is excellent." },
  { id: 'tp-6a42bc16309c159e281b35f4', platform: 'Trustpilot', reviewer: 'Kristen A', rating: 5, date: '2026-06-30',
    text: "The team at Hire Overseas is very responsive and easy to work with. Not only did they connect us with well qualified people, they helped us understand the culture of the people we were interviewing and ultimately hiring, which has helped us integrate them into our team more seamlessly." },
  { id: 'tp-6a42b805d7234daaac0a7f9e', platform: 'Trustpilot', reviewer: 'Cassie Saquing', rating: 5, date: '2026-06-30',
    text: "The high level of communication from the entire team at Hire Overseas is phenomenal! From the first search and interview to final hire date, the process is so smooth and clear. We have received highly qualified candidates every time we asked and have made excellent hires with Hire Overseas. Highly recommend if you are looking for healthcare admin or accounting support!!" },
  { id: 'tp-6a4295d19f687248d19ff8de', platform: 'Trustpilot', reviewer: 'Jacob Diament', rating: 5, date: '2026-06-30',
    text: "Harlan was great to work with and very Helpful" },
  { id: 'tp-6a42937c1112c7af1e90ed42', platform: 'Trustpilot', reviewer: 'ThinAir Consulting', rating: 5, date: '2026-06-30',
    text: "Amazing Experience, great to work with and really helped out our business" },
  { id: 'tp-6a3f5d916fc2184e8cd703cc', platform: 'Trustpilot', reviewer: 'Jeremiah Sekyi', rating: 5, date: '2026-06-28',
    text: "Had an absolutely wonderful experience with this company. Highly professional and committed to excellence. I wish I had found this service sooner." },
  { id: 'tp-6a3eec45714921fe0151c66d', platform: 'Trustpilot', reviewer: 'Tyler Moody', rating: 5, date: '2026-06-27',
    text: "Amazing team and even better talent finders! Process is smooth every time and always know how to find the best fit for the job!" },
  { id: 'tp-6a3ee91fad0217ceb6488a98', platform: 'Trustpilot', reviewer: 'Peter Arian', rating: 5, date: '2026-06-27',
    text: "Incredibly helpful team. The quality of talent has been a significant value add for us. I can't recommend enough" },
  { id: 'tp-6a3d025bc757fe1fb58ed1dd', platform: 'Trustpilot', reviewer: 'Jackson Greathouse Fall', rating: 5, date: '2026-06-26',
    text: "Incredibly positive experience with HireOverseas, initial pilot program exceeded expectations and we're looking forward to continuing integrating into our hiring. Can't recommend enough for smooth onboarding with top talent end to end" }
].map(r => ({ ...r, reply: '', status: 'needs_reply' }));

export function storageConfigured() { return Boolean(KV_URL && KV_TOKEN); }

// Run a single Redis command via the Upstash REST API.
async function redis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Storage error (HTTP ${res.status})`);
  const data = await res.json();
  return data.result;
}

export function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// HGETALL comes back as a flat [field, value, field, value, ...] array on Upstash
// (some clients return an object) — handle both, and skip any unparseable field.
function parseHash(result) {
  const out = [];
  const pushVal = (raw) => {
    if (typeof raw !== 'string') return;
    try { out.push(JSON.parse(raw)); } catch { /* skip corrupt field */ }
  };
  if (Array.isArray(result)) {
    for (let i = 1; i < result.length; i += 2) pushVal(result[i]);
  } else if (result && typeof result === 'object') {
    for (const v of Object.values(result)) pushVal(v);
  }
  return out;
}

// Seed once, guarded by a marker key so deleting every review doesn't re-seed.
export async function ensureSeeded() {
  const initialized = await redis(['GET', INIT_KEY]);
  if (initialized) return;
  const flat = [];
  for (const r of SEED_REVIEWS) { flat.push(r.id, JSON.stringify(r)); }
  if (flat.length) await redis(['HSET', HASH_KEY, ...flat]);
  await redis(['SET', SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS)]);
  await redis(['SET', INIT_KEY, '1']);
}

export async function getFullState() {
  await ensureSeeded();
  const [hashResult, settingsRaw, activityRaw] = await Promise.all([
    redis(['HGETALL', HASH_KEY]),
    redis(['GET', SETTINGS_KEY]),
    redis(['LRANGE', ACTIVITY_KEY, 0, ACTIVITY_MAX - 1])
  ]);

  const reviews = parseHash(hashResult);

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  if (settingsRaw) { try { settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(settingsRaw)); } catch { /* keep defaults */ } }

  const activityLog = (Array.isArray(activityRaw) ? activityRaw : [])
    .map(s => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);

  return { reviews, settings, activityLog };
}

// Add or overwrite specific reviews' fields (used for edits and new reviews from
// the browser). Only touches the given reviews' fields — never the whole hash.
export async function upsertReviews(list) {
  const flat = [];
  for (const r of list) {
    if (r && r.id) flat.push(String(r.id), JSON.stringify(r));
  }
  if (flat.length) await redis(['HSET', HASH_KEY, ...flat]);
}

// Add ONLY genuinely-new reviews (used by the cron). HSETNX writes the field only
// if it doesn't already exist, so a re-run or an existing edited review is never
// overwritten. Returns how many were actually added.
export async function addNewReviews(list) {
  let added = 0;
  for (const r of list) {
    if (!r || !r.id) continue;
    const res = await redis(['HSETNX', HASH_KEY, String(r.id), JSON.stringify(r)]);
    if (res === 1 || res === true) added++;
  }
  return added;
}

export async function deleteReviews(ids) {
  const clean = ids.map(String).filter(Boolean);
  if (clean.length) await redis(['HDEL', HASH_KEY, ...clean]);
}

export async function saveSettings(settings) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  await redis(['SET', SETTINGS_KEY, JSON.stringify(merged)]);
  return merged;
}

export async function appendActivity(text) {
  const entry = { id: genId(), ts: new Date().toISOString(), text: String(text).trim() };
  await redis(['LPUSH', ACTIVITY_KEY, JSON.stringify(entry)]);
  await redis(['LTRIM', ACTIVITY_KEY, 0, ACTIVITY_MAX - 1]);
  return entry;
}

// Parse a JSON request body, tolerating platforms that don't pre-parse it.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}
