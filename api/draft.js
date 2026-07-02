// POST /api/draft  <- { review, settings, isRegenerate }  ->  { reply }
//
// Server-side reply drafting so it works for anyone visiting the site — the Anthropic
// API key lives only in the ANTHROPIC_API_KEY environment variable, never in the client.

import Anthropic from '@anthropic-ai/sdk';

function sentimentOf(rating) {
  const n = Number(rating);
  if (n >= 4) return 'positive';
  if (n === 3) return 'neutral';
  return 'negative';
}

function buildPrompt(review, settings, isRegenerate) {
  const sentiment = sentimentOf(review.rating);
  const company = settings.companyName || 'our company';
  const isFounder = (settings.toneMode || 'founder') === 'founder';
  const signer = settings.signerName || (isFounder ? 'the founder' : `The ${company} Team`);

  let toneInstruction;
  if (sentiment === 'negative') {
    toneInstruction = 'Apologize sincerely, take ownership without being defensive, and invite them to continue the conversation privately (e.g. by email) so it can be made right. Do not be overly formal or robotic.';
  } else if (sentiment === 'neutral') {
    toneInstruction = 'Acknowledge both the positive and the constructive parts of their feedback, and mention that the feedback is being taken on board.';
  } else {
    toneInstruction = 'Be warm, specific, and genuine. Avoid generic phrases like "we appreciate your feedback" or "thank you for your kind words."';
  }

  const voiceInstruction = isFounder
    ? `Write in first person singular ("I"), as the founder of ${company} personally replying — not a support agent. Personal, direct, a little informal, like a founder who actually reads every review. It is fine to briefly reference the company or team, but the voice should read as one person, not "we".`
    : `Write in first person plural ("we"), as the ${company} team replying professionally.`;

  return `You are drafting a short public reply to a customer review on ${review.platform}.
Reviewer: ${review.reviewer || 'Anonymous'}
Rating: ${review.rating}/5 (${sentiment})
Review text: "${review.text}"

${voiceInstruction}

Write a reply of 2-4 sentences that:
- Thanks or acknowledges the reviewer by name if given
- References something specific from their review, not generic filler
- ${toneInstruction}
- Signs off naturally as "${signer}"
- Avoids corporate jargon, avoids sounding like a template, and avoids excessive exclamation points
${isRegenerate ? '- This is a regeneration: use a noticeably different opening line and structure than a typical first draft.' : ''}

Return ONLY the reply text. No preamble, no quotation marks around it.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'AI drafting is not configured (missing ANTHROPIC_API_KEY environment variable).' });
    return;
  }

  try {
    const { review, settings, isRegenerate } = req.body || {};
    if (!review || !review.text) {
      res.status(400).json({ error: 'Body must include a "review" with text.' });
      return;
    }

    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildPrompt(review, settings || {}, Boolean(isRegenerate)) }]
    });

    const reply = (message.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim();

    if (!reply) {
      res.status(502).json({ error: 'The model returned an empty reply. Try again.' });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Draft failed' });
  }
}
