// GET  /api/reviews  -> { reviews, settings, activityLog }
// POST /api/reviews  <- { reviews, settings, logEntry? }  -> updated { reviews, settings, activityLog }
//
// Shared state lives in Redis (Vercel KV / Upstash) so everyone visiting the site
// sees the same reviews, replies, statuses and activity log. The client polls GET
// every few seconds and POSTs the full { reviews, settings } on every local change.
//
// logEntry is the shape the client sends to record a notable event (a review being
// added, a reply being drafted, a status changing to "posted"). The server stamps it
// with a server-authoritative timestamp + id and prepends it to activityLog (capped
// at 100, newest first) — the client reads the returned activityLog to render the
// "Activity" panel.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = 'review-reply-manager:state:v1';

const DEFAULT_SETTINGS = { companyName: 'Hire Overseas', signerName: '', toneMode: 'founder' };

// Seed data used only the first time the store is empty. Pulled from the G2 and
// Trustpilot profile pages on 2026-07-02 (neither platform exposes a reply API here).
const SEED_REVIEWS = [
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

function storageConfigured() { return Boolean(KV_URL && KV_TOKEN); }

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

async function loadState() {
  const raw = await redis(['GET', STATE_KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveState(state) {
  await redis(['SET', STATE_KEY, JSON.stringify(state)]);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalize(state) {
  return {
    reviews: Array.isArray(state.reviews) ? state.reviews : [],
    settings: Object.assign({}, DEFAULT_SETTINGS, state.settings || {}),
    activityLog: Array.isArray(state.activityLog) ? state.activityLog : []
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback: manually read the stream if the platform didn't parse it.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
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
      let state = await loadState();
      if (!state) {
        state = { reviews: SEED_REVIEWS, settings: DEFAULT_SETTINGS, activityLog: [] };
        await saveState(state);
      }
      res.status(200).json(normalize(state));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const { reviews, settings, logEntry } = body || {};
      if (!Array.isArray(reviews)) {
        res.status(400).json({ error: 'Body must include a "reviews" array.' });
        return;
      }

      const current = (await loadState()) || {};
      let activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
      if (logEntry && typeof logEntry.text === 'string' && logEntry.text.trim()) {
        const entry = { id: genId(), ts: new Date().toISOString(), text: logEntry.text.trim() };
        activityLog = [entry, ...activityLog].slice(0, 100);
      }

      const state = {
        reviews,
        settings: Object.assign({}, DEFAULT_SETTINGS, settings || {}),
        activityLog
      };
      await saveState(state);
      res.status(200).json(normalize(state));
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
