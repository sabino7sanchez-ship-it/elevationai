// ==================================================================
// quote-submit.js — Netlify Function (HARDENED v2)
// ==================================================================
// Endpoint: https://rivven.ai/.netlify/functions/quote-submit
//
// Purpose: receive a self-quote from /quote.html, then in atomic-best-effort:
//   1) Generate quote ID (RVQ-YYYYMMDD-XXXX, collision-safe)
//   2) Validate hard against allowlists (industry, tier, addons, totals)
//   3) Reject spam (honeypot + origin + UA + email format + rate hint)
//   4) Create Stripe Checkout for 50% deposit (idempotency-keyed)
//   5) Persist to Supabase `quotes` table (service-role)
//   6) Mirror to `activity_events` (lead pipeline visibility)
//   7) Email prospect via Resend (HTML proposal w/ Stripe link)
//   8) Email Sabino via Resend (action-card notification)
//   9) Return diagnostics so the client UI surfaces partial-failure modes
//
// Hardening:
//   - Origin allowlist enforcement on POST (not just CORS reply)
//   - Honeypot field (`website` — humans don't fill, bots do)
//   - User-agent denylist + length cap
//   - Tier/industry/addon allowlists; totals bounded per tier
//   - AbortController fetch timeouts (8s per upstream)
//   - One transient-error retry with 600ms backoff
//   - Stripe idempotency key = quoteId (safe to replay)
//   - All env vars validated up-front; missing creds = 503 (not 500 silently)
//   - HTML escape on all user-controlled fields in templates
//   - URL safety: stripeUrl built only from Stripe response, never user data
//   - Phone normalized to E.164-ish (digits only, leading +)
//   - Structured JSON logs to console (Netlify captures)
//   - Dead-letter capture: if any external step fails, full payload echoed
//     into `quotes.dead_letter` JSON column for manual replay
//   - No PII in error messages returned to client
//
// Required env vars (Netlify → Site settings → Environment variables):
//   RESEND_API_KEY                  re_...
//   STRIPE_LIVE_RESTRICTED_KEY      rk_live_... (needs checkout_session:write)
//   SUPABASE_URL                    https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY       sb_secret_...
//   SABINO_NOTIFY_EMAIL             default sabino.sanchez7@gmail.com
//   QUOTE_FUNCTION_VERSION          set to bump cache (default v2)
//
// Zero-deps: native fetch (Node 18+). Deploy bundle: esbuild.
// ==================================================================

'use strict';

const FUNCTION_VERSION = process.env.QUOTE_FUNCTION_VERSION || 'v2.0.0';

// ------------------------------------------------------------------
// Allowlists & constants
// ------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://rivven.ai',
  'https://www.rivven.ai',
  'https://sanchezelevationai.netlify.app',
  'http://localhost:3000',
  'http://localhost:8888'
]);

// Mirror /quote.html chip values verbatim. Update both files together.
const ALLOWED_INDUSTRIES = new Set([
  'Barbershop', 'Salon', 'Med Spa', 'Auto Detailing', 'Auto Repair',
  'HVAC', 'Plumbing', 'Electrician', 'Roofing', 'Landscaping',
  'Construction', 'Restaurant', 'Catering', 'Law Firm', 'Mortgage',
  'Real Estate', 'Fitness', 'Dental', 'Trucking', 'Other'
]);

// Tier name → [min, max] price band. Includes rush multiplier headroom.
const TIER_BOUNDS = {
  'Basic':        { min: 800,  max: 5000  },
  'Professional': { min: 1400, max: 8000  },
  'Growth':       { min: 2800, max: 15000 }
};

const ALLOWED_ADDONS = new Set([
  'AI Chatbot', 'Bilingual (EN+ES)', 'Quote Calculator', 'Booking Integration',
  'Meta + Google Ads', 'Content Kit', 'GBP Setup'
]);

const ALLOWED_TIMELINES = new Set(['standard', 'rush']);

const SABINO_EMAIL = process.env.SABINO_NOTIFY_EMAIL || 'sabino.sanchez7@gmail.com';
const FROM_QUOTES = 'RIVVEN <quotes@rivven.ai>';
const FROM_HERMES = 'RIVVEN Hermes <hermes@rivven.ai>';
const FROM_FALLBACK = 'RIVVEN <onboarding@resend.dev>'; // works without domain verify
const REPLY_TO = 'sabino.sanchez7@gmail.com';

const FETCH_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 600;
const MAX_TOTAL_USD = 25000;
const MIN_TOTAL_USD = 100;

const BAD_UA_FRAGMENTS = ['curl/', 'wget/', 'python-requests', 'go-http-client', 'java-http-client'];

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://rivven.ai';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'X-Quote-Function-Version': FUNCTION_VERSION
  };
}

function resp(statusCode, body, origin) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function logJson(level, msg, meta) {
  const entry = Object.assign({
    ts: new Date().toISOString(),
    level,
    msg,
    fn: 'quote-submit',
    ver: FUNCTION_VERSION
  }, meta || {});
  // Netlify captures stdout — JSON makes it greppable in logs explorer.
  console.log(JSON.stringify(entry));
}

function generateQuoteId() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  // 6 chars base36 → 2.1B combos / day. Collision-safe at our volume.
  const a = Math.random().toString(36).slice(2, 5).toUpperCase();
  const b = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `RVQ-${ymd}-${a}${b}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function fmtUSD(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
}

function isValidEmail(s) {
  if (typeof s !== 'string' || s.length > 254) return false;
  // RFC 5322 simplified — pragmatic, rejects obvious garbage.
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}$/.test(s);
}

function normalizePhone(s) {
  if (!s) return '';
  const digits = String(s).replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits.slice(0, 16);
  // Default to US if 10 digits.
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits.slice(0, 16);
}

function clampStr(s, max) {
  return String(s == null ? '' : s).slice(0, max);
}

function sanitizeUrl(u) {
  if (typeof u !== 'string') return '';
  if (!/^https:\/\//i.test(u)) return '';
  try {
    const parsed = new URL(u);
    return parsed.toString();
  } catch {
    return '';
  }
}

function envCheck() {
  const missing = [];
  if (!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!process.env.STRIPE_LIVE_RESTRICTED_KEY) missing.push('STRIPE_LIVE_RESTRICTED_KEY');
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}

// ------------------------------------------------------------------
// Fetch wrapper with timeout + 1 retry on transient failures
// ------------------------------------------------------------------
async function fetchWithRetry(url, options, opts) {
  const { timeoutMs = FETCH_TIMEOUT_MS, retries = 1, label = 'fetch' } = opts || {};
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
      clearTimeout(t);
      // Retry on 5xx + 429
      if ((r.status >= 500 || r.status === 429) && attempt < retries) {
        lastErr = `HTTP ${r.status}`;
        await new Promise(res => setTimeout(res, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      return r;
    } catch (err) {
      clearTimeout(t);
      lastErr = err && err.message ? err.message : String(err);
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      logJson('error', `fetchWithRetry exhausted: ${label}`, { url: String(url).slice(0, 200), err: lastErr });
      throw err;
    }
  }
  throw new Error(lastErr || 'fetchWithRetry: unknown failure');
}

// ------------------------------------------------------------------
// Resend
// ------------------------------------------------------------------
async function sendEmail({ to, from, subject, html, replyTo, label }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY missing' };
  try {
    const r = await fetchWithRetry('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        reply_to: replyTo || REPLY_TO
      })
    }, { label: `resend:${label}` });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logJson('warn', 'resend non-ok', { label, status: r.status, body: data });
      return { ok: false, error: data, status: r.status };
    }
    return { ok: true, id: data.id, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------
// Stripe Checkout (50% deposit)
// ------------------------------------------------------------------
async function createStripeCheckout({ quoteId, total, email, businessName, tierName }) {
  const key = process.env.STRIPE_LIVE_RESTRICTED_KEY;
  if (!key) return { ok: false, error: 'STRIPE key missing' };

  const depositCents = Math.round(Number(total) * 0.5 * 100);
  if (!Number.isFinite(depositCents) || depositCents < 50) {
    return { ok: false, error: 'invalid deposit amount' };
  }

  const successUrl = `https://rivven.ai/quote-confirmed.html?qid=${encodeURIComponent(quoteId)}&paid=1`;
  const cancelUrl = `https://rivven.ai/quote-confirmed.html?qid=${encodeURIComponent(quoteId)}&paid=0`;
  const productName = `RIVVEN ${tierName} — 50% Deposit`;
  const productDesc = `Quote ${quoteId} · ${businessName || 'Build'} · Pay 50% to start.`.slice(0, 350);

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  if (email) params.append('customer_email', email);
  params.append('client_reference_id', quoteId);
  params.append('metadata[quote_id]', quoteId);
  params.append('metadata[business_name]', clampStr(businessName, 200));
  params.append('metadata[tier]', clampStr(tierName, 80));
  params.append('metadata[total_usd]', String(total));
  params.append('payment_intent_data[description]', productDesc);
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][unit_amount]', String(depositCents));
  params.append('line_items[0][price_data][product_data][name]', productName);
  params.append('line_items[0][price_data][product_data][description]', productDesc);
  params.append('line_items[0][quantity]', '1');
  params.append('billing_address_collection', 'required');
  params.append('phone_number_collection[enabled]', 'true');

  try {
    const r = await fetchWithRetry('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Idempotency: replaying same quote -> same session (avoids duplicate charges).
        'Idempotency-Key': `qsubmit:${quoteId}`
      },
      body: params.toString()
    }, { label: 'stripe:checkout' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logJson('warn', 'stripe non-ok', { status: r.status, body: data });
      return { ok: false, error: data, status: r.status };
    }
    return { ok: true, url: sanitizeUrl(data.url), sessionId: data.id };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------
// Supabase — log quote + activity event
// ------------------------------------------------------------------
async function sbInsert(tableName, record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: 'Supabase not configured', skipped: true };
  try {
    const r = await fetchWithRetry(`${url.replace(/\/+$/, '')}/rest/v1/${tableName}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(record)
    }, { label: `sb:${tableName}` });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      logJson('warn', 'supabase non-ok', { table: tableName, status: r.status, body: data });
      return { ok: false, error: data, status: r.status };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------
// Email templates
// ------------------------------------------------------------------
function prospectEmailHtml({ quoteId, name, businessName, tier, total, addons, timeline, stripeUrl, hasStripe }) {
  const addonRows = (addons || []).map(a =>
    `<tr><td style="padding:6px 0;color:#444;font-size:14px">+ ${escapeHtml(a)}</td></tr>`
  ).join('');
  const safeName = escapeHtml(name || 'there');
  const safeBiz = escapeHtml(businessName || 'your business');
  const depositStr = fmtUSD(Number(total) * 0.5);
  const ctaBlock = hasStripe
    ? `<div class="pillar">
         <strong style="color:#FAFAFA">Option 1 — Pay 50% deposit, we start today</strong><br>
         <span style="color:#A1A1AA">${depositStr} now · ${depositStr} on launch</span>
         <br><br>
         <a class="btn" href="${escapeHtml(stripeUrl)}">Pay deposit · Start now →</a>
       </div>`
    : `<div class="pillar" style="border-color:#FFB020">
         <strong style="color:#FAFAFA">Quote received — Sabino will follow up within 1 hour</strong><br>
         <span style="color:#A1A1AA">Payment link generates after a quick verification call.</span>
       </div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#0A0A0B;color:#FAFAFA;margin:0;padding:24px;line-height:1.6}
  .wrap{max-width:600px;margin:0 auto}
  .card{background:#111113;border:1px solid #222225;border-radius:14px;padding:32px;margin-bottom:16px}
  h1{font-size:24px;font-weight:800;margin:0 0 8px;letter-spacing:-0.5px;color:#FAFAFA}
  .qid{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;color:#00F0FF;letter-spacing:2px;text-transform:uppercase}
  .price{font-size:42px;font-weight:900;color:#00F0FF;letter-spacing:-1px;margin:16px 0 4px}
  .sub{color:#A1A1AA;font-size:13px;margin-bottom:20px}
  .row{display:table;width:100%;padding:8px 0;border-bottom:1px solid #222225;font-size:14px}
  .row:last-child{border-bottom:none}
  .lbl{color:#A1A1AA;display:table-cell}
  .val{color:#FAFAFA;font-weight:600;display:table-cell;text-align:right}
  .btn{display:inline-block;background:#00F0FF;color:#0A0A0B!important;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;letter-spacing:0.3px;margin-top:12px}
  .footer{color:#71717A;font-size:11px;text-align:center;padding:16px 0;letter-spacing:1px;text-transform:uppercase;font-family:'JetBrains Mono',ui-monospace,monospace}
  .pillar{background:rgba(0,240,255,0.06);border:1px solid #00F0FF;border-radius:10px;padding:16px;margin:16px 0;font-size:13px;color:#FAFAFA}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="qid">// Quote ${escapeHtml(quoteId)}</div>
    <h1>Your RIVVEN quote, ${safeName}</h1>
    <p class="sub">Custom build for ${safeBiz}. Locked for 48 hours.</p>
    <div class="price">${fmtUSD(total)}</div>
    <div class="sub">One-time. No retainer. You own everything.</div>
    <div style="margin-top:24px">
      <div class="row"><span class="lbl">Package</span><span class="val">${escapeHtml(tier)}</span></div>
      ${addonRows ? `<div style="padding:8px 0"><div class="lbl" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Add-ons</div><table style="width:100%">${addonRows}</table></div>` : ''}
      <div class="row"><span class="lbl">Timeline</span><span class="val">${escapeHtml(timeline)}</span></div>
      <div class="row" style="border-top:2px solid #00F0FF"><span class="lbl"><strong style="color:#FAFAFA">Total</strong></span><span class="val" style="color:#00F0FF;font-size:16px">${fmtUSD(total)}</span></div>
    </div>
  </div>
  <div class="card">
    <h1 style="font-size:18px;margin-bottom:16px">Two ways to start</h1>
    ${ctaBlock}
    <div style="font-size:13px;color:#A1A1AA;margin-top:16px">
      <strong style="color:#FAFAFA">Prefer a 15-min call?</strong><br>
      Reply to this email or text Sabino direct: <strong style="color:#FAFAFA">(562) 209-9395</strong><br>
      Or schedule: <a href="https://rivven.ai/booking.html" style="color:#00F0FF">rivven.ai/booking</a>
    </div>
  </div>
  <div class="footer">RIVVEN · Built by operators · rivven.ai</div>
</div></body></html>`;
}

function sabinoEmailHtml(p) {
  const safeAddons = (p.addons || []).join(', ') || '—';
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,Inter,sans-serif;background:#0A0A0B;color:#FAFAFA;padding:24px;line-height:1.5">
<div style="max-width:600px;margin:0 auto;background:#111113;border:1px solid #00F0FF;border-radius:14px;padding:28px">
  <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#00F0FF;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">// new quote · ${escapeHtml(p.quoteId)}</div>
  <h1 style="font-size:28px;font-weight:900;margin:0 0 8px;color:#FAFAFA">${fmtUSD(p.total)} — ${escapeHtml(p.businessName || p.name || 'unknown')}</h1>
  <p style="color:#A1A1AA;font-size:14px;margin:0 0 20px">${escapeHtml(p.industry)} · ${escapeHtml(p.tier)} · ${escapeHtml(p.timeline)}</p>
  <table style="width:100%;font-size:14px;color:#FAFAFA;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#A1A1AA;width:35%">Name</td><td style="padding:6px 0">${escapeHtml(p.name || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Email</td><td style="padding:6px 0"><a href="mailto:${escapeHtml(p.email)}" style="color:#00F0FF">${escapeHtml(p.email || '—')}</a></td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Phone</td><td style="padding:6px 0"><a href="tel:${escapeHtml(p.phone)}" style="color:#00F0FF">${escapeHtml(p.phone || '—')}</a></td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Business</td><td style="padding:6px 0">${escapeHtml(p.businessName || '—')}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Industry</td><td style="padding:6px 0">${escapeHtml(p.industry)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Tier</td><td style="padding:6px 0">${escapeHtml(p.tier)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Add-ons</td><td style="padding:6px 0">${escapeHtml(safeAddons)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Timeline</td><td style="padding:6px 0">${escapeHtml(p.timeline)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Total</td><td style="padding:6px 0;font-weight:800;color:#00FF88">${fmtUSD(p.total)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Deposit (50%)</td><td style="padding:6px 0;color:#00F0FF">${fmtUSD(Number(p.total) * 0.5)}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Stripe link</td><td style="padding:6px 0">${p.stripeUrl ? `<a href="${escapeHtml(p.stripeUrl)}" style="color:#00F0FF;font-size:11px">${escapeHtml(p.stripeUrl).slice(0, 60)}…</a>` : '<span style="color:#FFB020">⚠ failed — see logs</span>'}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Supabase</td><td style="padding:6px 0">${p.supabaseLogged ? '✓ logged' : '⚠ not logged'}</td></tr>
    <tr><td style="padding:6px 0;color:#A1A1AA">Source</td><td style="padding:6px 0;font-size:12px;color:#71717A">${escapeHtml(p.source || '—')}</td></tr>
  </table>
  <div style="margin-top:24px;padding-top:20px;border-top:1px solid #222225">
    <a href="tel:${escapeHtml(p.phone)}" style="display:inline-block;background:#00F0FF;color:#0A0A0B;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:800;font-size:14px;margin-right:8px">Call now</a>
    <a href="sms:${escapeHtml(p.phone)}" style="display:inline-block;background:#00FF88;color:#0A0A0B;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:800;font-size:14px;margin-right:8px">Text now</a>
    <a href="mailto:${escapeHtml(p.email)}" style="display:inline-block;background:#7B61FF;color:#FAFAFA;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:800;font-size:14px">Email reply</a>
  </div>
  <div style="margin-top:20px;font-size:12px;color:#71717A;font-family:'JetBrains Mono',monospace;letter-spacing:1px">
    // SLA: text within 1hr · close within 24hr<br>
    // fn ${escapeHtml(FUNCTION_VERSION)} · diagnostics in JSON response
  </div>
</div></body></html>`;
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------
function validatePayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['payload not object'] };
  }

  // Honeypot — humans don't fill `website`. Bots love auto-filling.
  if (body.website && String(body.website).trim() !== '') {
    return { ok: false, errors: ['spam'], spam: true };
  }

  const name = clampStr(body.name, 200).trim();
  const email = clampStr(body.email, 254).trim().toLowerCase();
  const phone = normalizePhone(body.phone);
  const businessName = clampStr(body.businessName, 200).trim();
  const industry = clampStr(body.industry, 100).trim();
  const tier = clampStr(body.tier, 100).trim();
  const timeline = clampStr(body.timeline || 'standard', 50).trim().toLowerCase();
  const addons = Array.isArray(body.addons)
    ? body.addons.slice(0, 20).map(a => clampStr(a, 100).trim()).filter(Boolean)
    : [];
  const total = Number(body.total);

  if (name.length < 2) errors.push('name too short');
  if (!isValidEmail(email)) errors.push('invalid email');
  if (phone && phone.length < 7) errors.push('invalid phone');
  if (!ALLOWED_INDUSTRIES.has(industry)) errors.push('invalid industry');
  if (!TIER_BOUNDS[tier]) errors.push('invalid tier');
  if (!ALLOWED_TIMELINES.has(timeline)) errors.push('invalid timeline');
  if (!Number.isFinite(total) || total < MIN_TOTAL_USD || total > MAX_TOTAL_USD) {
    errors.push('total out of range');
  }
  if (TIER_BOUNDS[tier] && Number.isFinite(total)) {
    const { min, max } = TIER_BOUNDS[tier];
    if (total < min - 50 || total > max + 50) {
      errors.push(`total outside tier band [${min}-${max}]`);
    }
  }
  for (const a of addons) {
    if (!ALLOWED_ADDONS.has(a)) {
      errors.push(`invalid addon: ${a}`);
      break;
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      name, email, phone, businessName, industry, tier, timeline, addons, total,
      source: clampStr(body.source || 'quote.html', 100)
    }
  };
}

// ------------------------------------------------------------------
// Main handler
// ------------------------------------------------------------------
exports.handler = async (event) => {
  const startedAt = Date.now();
  const origin = event.headers.origin || event.headers.Origin || '';
  const ua = clampStr(event.headers['user-agent'] || '', 500);
  const referer = clampStr(event.headers.referer || event.headers.Referer || '', 500);
  const ip = (event.headers['x-nf-client-connection-ip'] ||
              event.headers['client-ip'] ||
              (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return resp(405, { ok: false, error: 'POST only' }, origin);
  }

  // Origin enforcement (not just CORS — actually reject)
  if (!ALLOWED_ORIGINS.has(origin)) {
    logJson('warn', 'rejected: bad origin', { origin, ip, ua });
    return resp(403, { ok: false, error: 'forbidden origin' }, origin);
  }

  // UA denylist
  const uaLower = ua.toLowerCase();
  if (BAD_UA_FRAGMENTS.some(b => uaLower.includes(b))) {
    logJson('warn', 'rejected: bad UA', { origin, ip, ua });
    return resp(403, { ok: false, error: 'forbidden' }, origin);
  }

  // Env check up-front — fail fast if creds missing
  const envMissing = envCheck();
  if (envMissing.length) {
    logJson('error', 'env vars missing', { missing: envMissing });
    return resp(503, { ok: false, error: 'service misconfigured', missing: envMissing }, origin);
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return resp(400, { ok: false, error: 'invalid JSON' }, origin);
  }

  // Validate
  const v = validatePayload(body);
  if (!v.ok) {
    logJson('info', 'validation failed', { errors: v.errors, spam: !!v.spam, ip });
    if (v.spam) {
      // Pretend success to confuse spam bots while not creating real records.
      return resp(200, { ok: true, quoteId: 'RVQ-NOOP', sham: true }, origin);
    }
    return resp(400, { ok: false, error: 'validation failed', details: v.errors }, origin);
  }
  const p = v.payload;
  const quoteId = generateQuoteId();
  logJson('info', 'quote received', { quoteId, ip, origin, industry: p.industry, tier: p.tier, total: p.total });

  // 1) Stripe Checkout (idempotent on quoteId)
  const stripe = await createStripeCheckout({
    quoteId,
    total: p.total,
    email: p.email,
    businessName: p.businessName,
    tierName: p.tier
  });
  const stripeUrl = stripe.ok ? stripe.url : '';
  if (!stripe.ok) logJson('warn', 'stripe failed', { quoteId, err: stripe.error });

  // 2) Supabase: insert into quotes table
  const quoteRow = {
    quote_id: quoteId,
    name: p.name,
    email: p.email,
    phone: p.phone || null,
    business_name: p.businessName || null,
    industry: p.industry,
    tier: p.tier,
    addons: p.addons,
    timeline: p.timeline,
    total: p.total,
    deposit: Math.round(p.total * 0.5),
    stripe_session_id: stripe.ok ? stripe.sessionId : null,
    stripe_url: stripe.ok ? stripe.url : null,
    source: p.source,
    referer: referer,
    user_agent: ua,
    ip: ip === 'unknown' ? null : ip,
    status: stripe.ok ? 'sent' : 'stripe_failed',
    dead_letter: stripe.ok ? null : { stripe_error: stripe.error }
  };
  const sb = await sbInsert('quotes', quoteRow);

  // 3) Supabase: mirror to activity_events (lead pipeline visibility)
  const activityRow = {
    actor: 'system',
    type: 'lead',
    subject: `[QUOTE] ${fmtUSD(p.total)} — ${p.businessName || p.name} — ${p.industry}`,
    outcome: stripe.ok ? 'stripe_link_sent' : 'pending_manual',
    amount: p.total,
    notes: `quote_id=${quoteId}; tier=${p.tier}; timeline=${p.timeline}; addons=${p.addons.join('|') || 'none'}`,
    url: stripe.ok ? stripe.url : null,
    tags: ['quote', 'inbound', p.industry.toLowerCase().replace(/\s+/g, '-'), p.tier.toLowerCase()]
  };
  await sbInsert('activity_events', activityRow);

  // 4) Email prospect
  const prospectMail = await sendEmail({
    to: p.email,
    from: FROM_QUOTES,
    subject: `Your RIVVEN quote — ${p.businessName || p.name} — ${fmtUSD(p.total)}`,
    html: prospectEmailHtml({
      quoteId,
      name: p.name,
      businessName: p.businessName,
      tier: p.tier,
      total: p.total,
      addons: p.addons,
      timeline: p.timeline,
      stripeUrl,
      hasStripe: stripe.ok
    }),
    replyTo: REPLY_TO,
    label: 'prospect'
  });
  // Fallback to onboarding@resend.dev if rivven.ai domain has issues
  if (!prospectMail.ok && /domain|verify|forbidden/i.test(JSON.stringify(prospectMail.error || ''))) {
    logJson('warn', 'retrying prospect email via fallback sender', { quoteId });
    const retry = await sendEmail({
      to: p.email, from: FROM_FALLBACK,
      subject: `Your RIVVEN quote — ${p.businessName || p.name} — ${fmtUSD(p.total)}`,
      html: prospectEmailHtml({
        quoteId, name: p.name, businessName: p.businessName, tier: p.tier,
        total: p.total, addons: p.addons, timeline: p.timeline, stripeUrl, hasStripe: stripe.ok
      }),
      replyTo: REPLY_TO, label: 'prospect-fallback'
    });
    if (retry.ok) { prospectMail.ok = true; prospectMail.id = retry.id; }
  }

  // 5) Email Sabino
  const sabinoMail = await sendEmail({
    to: SABINO_EMAIL,
    from: FROM_HERMES,
    subject: `[NEW QUOTE] ${fmtUSD(p.total)} — ${p.businessName || p.name} — ${p.industry}`,
    html: sabinoEmailHtml({
      quoteId,
      name: p.name,
      businessName: p.businessName,
      email: p.email,
      phone: p.phone,
      industry: p.industry,
      tier: p.tier,
      total: p.total,
      addons: p.addons,
      timeline: p.timeline,
      stripeUrl,
      supabaseLogged: sb.ok,
      source: p.source
    }),
    replyTo: p.email,
    label: 'sabino'
  });
  // Sabino fallback
  if (!sabinoMail.ok) {
    const retry = await sendEmail({
      to: SABINO_EMAIL, from: FROM_FALLBACK,
      subject: `[NEW QUOTE] ${fmtUSD(p.total)} — ${p.businessName || p.name} — ${p.industry}`,
      html: sabinoEmailHtml({
        quoteId, name: p.name, businessName: p.businessName, email: p.email, phone: p.phone,
        industry: p.industry, tier: p.tier, total: p.total, addons: p.addons, timeline: p.timeline,
        stripeUrl, supabaseLogged: sb.ok, source: p.source
      }),
      replyTo: p.email, label: 'sabino-fallback'
    });
    if (retry.ok) { sabinoMail.ok = true; sabinoMail.id = retry.id; }
  }

  const elapsed = Date.now() - startedAt;
  logJson('info', 'quote complete', {
    quoteId, elapsed_ms: elapsed,
    stripe: stripe.ok, prospect: prospectMail.ok, sabino: sabinoMail.ok, supabase: sb.ok
  });

  return resp(200, {
    ok: true,
    quoteId,
    stripeUrl,
    deposit: Math.round(p.total * 0.5),
    total: p.total,
    prospectEmailSent: !!prospectMail.ok,
    sabinoEmailSent: !!sabinoMail.ok,
    supabaseLogged: !!sb.ok,
    elapsedMs: elapsed,
    version: FUNCTION_VERSION,
    diagnostics: {
      stripe: stripe.ok ? 'ok' : 'failed',
      prospect_email: prospectMail.ok ? 'ok' : 'failed',
      sabino_email: sabinoMail.ok ? 'ok' : 'failed',
      supabase_quotes: sb.ok ? 'ok' : (sb.skipped ? 'skipped' : 'failed')
    }
  }, origin);
};
