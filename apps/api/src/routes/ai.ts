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
 * Anthropic model ID — sourced from env so we can roll forward without
 * a code deploy when Anthropic retires a model.
 *
 * The previous pin `claude-sonnet-4-20250514` was retired by Anthropic
 * on 2026-04-20 and the prod /enhance-description endpoint started
 * returning HTTP 404 with body `model: claude-sonnet-4-20250514`.
 * Default updated to `claude-sonnet-4-5-20250929` (Sonnet 4.5 GA).
 *
 * To roll forward at any time without a deploy, set ANTHROPIC_MODEL on
 * Railway to the new model ID — server picks it up on next request.
 */
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929';

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
    let enhanced = '';
    let retries = 3;
    let delay = 1000;
    while (retries > 0) {
      try {
        const message = await anthropic.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          messages: [{ role: 'user', content: userPrompt }],
          system: systemPrompt,
        });
        enhanced = (message.content[0] as { type: string; text: string }).text?.trim() || '';
        break;
      } catch (err: any) {
        if (err?.status === 529 && retries > 1) {
          retries--;
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
        } else {
          throw err;
        }
      }
    }

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
