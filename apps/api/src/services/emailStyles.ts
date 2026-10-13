/**
 * Inline styles for every email (N182). Gmail drops a <style> block, so a
 * class that only the block defined styles nothing there: the B4 test email
 * lost its body padding and its portal button became a plain link, and a
 * header whose navy came from the block put a white title on white.
 *
 * Each string below is one rule of the old block (BASE_STYLE, removed), and
 * each element carries its rule inline, followed by its own inline style,
 * which wins where both set a property, as it did over the class. So a client
 * that honoured the block sees the same email, and Gmail now sees it too
 * (scripts/test-letterhead-b5.ts holds every element to the declarations the
 * block and its own style gave it).
 *
 * Descendant rules (".hdr h1", ".kpi .n", ".rrow p") are applied to those
 * descendants by hand.
 */
export const ES = {
  card:   'background:#fff;border-radius:8px;max-width:640px;margin:0 auto;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)',
  hdr:    'background:#0B1526;color:#F59E0B;padding:24px 28px',
  hdrH1:  'margin:0;font-size:22px;letter-spacing:3px',
  brand:  'font-size:11px;color:#F59E0B;letter-spacing:4px;font-weight:700;margin-bottom:6px',
  hdrP:   'margin:4px 0 0;color:#888;font-size:12px;letter-spacing:2px',
  body:   'padding:24px 28px',
  kpi:    'display:inline-block;background:#f5f5f5;border-radius:6px;padding:10px 20px;margin:4px 8px 4px 0;text-align:center',
  kpiN:   'font-size:26px;font-weight:700;color:#0B1526',
  kpiL:   'font-size:10px;color:#999;letter-spacing:1px',
  rrow:   'border-left:3px solid;padding:10px 14px;margin:8px 0;background:#fafafa;border-radius:0 6px 6px 0',
  rrowP:  'margin:3px 0;font-size:13px',
  footer: 'background:#f5f5f5;padding:14px 28px;font-size:11px;color:#aaa;text-align:center',
  btn:    'display:inline-block;background:#F59E0B;color:#0B1526;font-weight:700;padding:10px 20px;border-radius:6px;text-decoration:none;letter-spacing:1px;font-size:13px;margin-top:16px',
} as const;

/**
 * The page every email sits on: what the old `body` rule gave (the grey
 * background, the 20 px around the card, the font), as a full-width table,
 * because a mail client keeps a table's inline style and ignores a body rule.
 */
export function emailPage(card: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><tr><td style="padding:20px">${card}</td></tr></table>`;
}
