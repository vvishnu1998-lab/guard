/**
 * AI Routes — server-side proxy to Anthropic Claude.
 * Guards and admins can call these; the API key never leaves the server.
 */
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth';
import { Sentry } from '../services/sentry';

const router = Router();

/**
 * ENHANCEMENT_TIMEOUT_MS and maxRetries are a pair -- changing one without the
 * other does not bound anything.
 *
 * The SDK default timeout is 10 MINUTES and its default maxRetries is 2, and
 * the SDK's own docs note that "request timeouts are retried by default, so in
 * a worst-case scenario you may wait much longer than this timeout". Layered
 * under the 529 loop below, an unresponsive upstream could hold a guard's
 * spinner for the better part of an hour.
 *
 * maxRetries: 0 hands retry policy entirely to the loop below, so the worst
 * case is bounded and countable: 2 attempts x 8s + one 1s backoff = 17s.
 *
 * See docs/OPS/INCIDENTS/2026-09-06-enhancement-credit-exhaustion.md.
 */
const ENHANCEMENT_TIMEOUT_MS = 8_000;

const anthropic = new Anthropic({
  apiKey:     process.env.ANTHROPIC_API_KEY,
  timeout:    ENHANCEMENT_TIMEOUT_MS,
  maxRetries: 0,
});

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
    // 2 attempts total, i.e. ONE retry, and only for 529 (overloaded). Was 3.
    // A guard is watching a spinner; a third attempt buys little and costs 8s.
    let retries = 2;
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
      // Same shape as the catch below: stable code, guard-safe copy.
      Sentry.captureMessage('enhancement_failed', {
        level: 'warning',
        tags:  { status: 'empty', flow: 'report_enhance' },
        extra: { guard_id: req.user!.sub, company_id: req.user!.company_id ?? null },
      } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
      console.error(
        `[ai.enhance.failed] guard=${req.user!.sub} company=${req.user!.company_id ?? 'n/a'} ` +
        `status=empty name=EmptyResponse`,
      );
      return res.status(503).json({
        error:   'ENHANCEMENT_UNAVAILABLE',
        message: 'Enhancement unavailable — your text will be submitted as written.',
      });
    }

    res.json({ enhanced });
  } catch (err: any) {
    // NEVER return err.message. On 2026-09-06 this line put Anthropic's own
    // billing text -- "Your credit balance is too low to access the Anthropic
    // API. Please go to Plans & Billing..." -- into the client-facing `error`
    // field, and a STARNET guard read it in a modal on their phone mid-shift.
    //
    // apps/mobile/lib/errorCopy.ts:53 renders any ApiError.message to the guard
    // verbatim, by contract: that field is server-AUTHORED guard-facing copy.
    // The defect was putting an upstream VENDOR's message into it.
    //
    // Per the error contract: `error` is a stable CODE, `message` is the copy.
    const status = typeof err?.status === 'number' ? err.status : 0;

    // Attribution parity with the success line above. Until now the success
    // path logged guard= and company= and the FAILURE path logged neither, so
    // the 9 failures on 2026-09-06 could not be attributed to a guard at all.
    console.error(
      `[ai.enhance.failed] guard=${req.user!.sub} company=${req.user!.company_id ?? 'n/a'} ` +
      `status=${status} name=${err?.name ?? 'unknown'}`,
      err,
    );

    // Tags stay low-cardinality and carry NO guard identity, per
    // docs/OPS/POLICY.md. Ids go in extra.
    Sentry.captureMessage('enhancement_failed', {
      level: 'warning',
      tags:  { status: String(status), flow: 'report_enhance' },
      extra: {
        guard_id:   req.user!.sub,
        company_id: req.user!.company_id ?? null,
        error_name: err?.name ?? 'unknown',
      },
    } as unknown as Parameters<typeof Sentry.captureMessage>[1]);

    res.status(503).json({
      error:   'ENHANCEMENT_UNAVAILABLE',
      message: 'Enhancement unavailable — your text will be submitted as written.',
    });
  }
});

export default router;
