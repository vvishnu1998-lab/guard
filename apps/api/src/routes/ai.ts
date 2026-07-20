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

// ── Finding #7: in-memory AI rate limit (reduced scope) ──────────────────────
// Bounds Anthropic spend from a compromised/looping account. CAVEATS:
//   * In-memory only — a process restart clears all counters.
//   * Single-instance only — if Railway scales to N instances, each keeps its
//     own counters, so the effective ceiling is N × these limits.
// A durable, cross-instance (schema-backed) limiter is a backlog item; ship
// this now and harden when abuse is actually observed. Values are tunable.
const PER_GUARD_LIMIT     = 20;          // requests per rolling hour, per actor
const PER_GUARD_WINDOW_MS = 3_600_000;   // 1 hour
const GLOBAL_DAILY_LIMIT  = 500;         // requests per rolling 24h, all actors
const GLOBAL_WINDOW_MS    = 86_400_000;  // 24 hours
const MAX_INPUT_CHARS     = 5000;

const perGuardBuckets = new Map<string, { count: number; resetAt: number }>();
let globalBucket = { count: 0, resetAt: 0 };

/**
 * Returns null if the request is allowed (and records the hit against both the
 * global and per-actor budgets), or a 429 descriptor if blocked. The global
 * cap is checked FIRST — when the platform-wide daily budget is exhausted we
 * fail closed for everyone, not just the heaviest actor.
 */
function checkRateLimit(actorId: string, now: number):
  | null
  | { scope: 'global' | 'guard'; retryAfterSec: number } {
  if (now >= globalBucket.resetAt) globalBucket = { count: 0, resetAt: now + GLOBAL_WINDOW_MS };
  if (globalBucket.count >= GLOBAL_DAILY_LIMIT) {
    return { scope: 'global', retryAfterSec: Math.ceil((globalBucket.resetAt - now) / 1000) };
  }

  let bucket = perGuardBuckets.get(actorId);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + PER_GUARD_WINDOW_MS };
    perGuardBuckets.set(actorId, bucket);
  }
  if (bucket.count >= PER_GUARD_LIMIT) {
    return { scope: 'guard', retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  // Allowed — record the hit against both budgets.
  bucket.count += 1;
  globalBucket.count += 1;
  return null;
}

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
  if (text.trim().length > MAX_INPUT_CHARS) {
    return res.status(400).json({ error: `text must be at most ${MAX_INPUT_CHARS} characters` });
  }

  // Finding #7: bound spend BEFORE the paid call. checkRateLimit increments on
  // gate pass, so a failed/looping call still counts (the internal 529 retry
  // loop below stays one logical request).
  const limited = checkRateLimit(req.user!.sub, Date.now());
  if (limited) {
    res.setHeader('Retry-After', String(limited.retryAfterSec));
    return res.status(429).json({
      error: limited.scope === 'global'
        ? 'AI enhancement is temporarily unavailable (daily limit reached). Please try again later.'
        : `Too many AI enhancement requests. Try again in about ${Math.ceil(limited.retryAfterSec / 60)} minutes.`,
      retry_after_seconds: limited.retryAfterSec,
    });
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
        // Finding #7 observability: guard + company + token usage per call.
        console.log(
          `[ai.enhance.success] guard=${req.user!.sub} company=${req.user!.company_id ?? 'n/a'} ` +
          `in_tokens=${message.usage?.input_tokens ?? '?'} out_tokens=${message.usage?.output_tokens ?? '?'}`,
        );
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
