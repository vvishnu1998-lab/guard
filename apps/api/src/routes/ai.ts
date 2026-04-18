/**
 * AI Routes — server-side proxy to Anthropic Claude.
 * Guards and admins can call these; the API key never leaves the server.
 */
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * POST /api/ai/enhance-description
 * Body: { text: string, report_type: 'activity' | 'incident' | 'maintenance' }
 * Returns: { enhanced: string }
 *
 * Rewrites a guard's raw description into a clear, professional security report entry.
 * Preserves all facts — only improves language and structure.
 */
router.post('/enhance-description', requireAuth('guard', 'company_admin'), async (req, res) => {
  const { text, report_type } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'text must be at least 10 characters' });
  }

  const type = report_type ?? 'activity';

  const systemPrompt = `You are a professional security report editor. Your job is to rewrite a guard's raw field notes into a clear, professional security report entry.

Rules:
- Preserve ALL facts, times, names, and details from the original
- Use formal, professional language suitable for a security report
- Write in past tense, first person (e.g. "Observed...", "Conducted...", "Noted...")
- Be concise but thorough — no fluff
- Do NOT add information that wasn't in the original
- Do NOT add placeholder text like "[INSERT TIME]"
- Return ONLY the enhanced description text — no preamble, no labels, no quotes`;

  const userPrompt = `Report type: ${type}

Original description:
${text.trim()}

Rewrite this as a professional security report entry:`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    const enhanced = (message.content[0] as { type: string; text: string }).text?.trim();
    if (!enhanced) {
      return res.status(500).json({ error: 'Empty response from AI' });
    }

    res.json({ enhanced });
  } catch (err: any) {
    console.error('[AI enhance-description] Error:', err);
    res.status(500).json({ error: err?.message ?? 'AI enhancement failed' });
  }
});

export default router;
