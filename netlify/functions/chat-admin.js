// ==================================================================
// chat-admin.js — Admin API for RIVVEN AI Chat conversations
// ------------------------------------------------------------------
// Read-only endpoint used by /portal/admin.html "Chats" view.
//
//   GET /.netlify/functions/chat-admin?mode=sessions&limit=50
//     → { sessions: [...] }  from v_chat_sessions_admin view
//
//   GET /.netlify/functions/chat-admin?mode=messages&session_id=<id>
//     → { messages: [...] }  all messages for one session
//
//   GET /.netlify/functions/chat-admin?mode=stats
//     → { stats: {total_sessions, active_24h, leads_captured, ...} }
//
// Auth: shared admin token in `x-admin-token` header. Set
// RIVVEN_ADMIN_TOKEN in Netlify env vars; the portal auth.js attaches
// it to every request.
// ==================================================================

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.RIVVEN_ADMIN_TOKEN || '';

const ALLOWED_ORIGINS = [
  'https://rivven.ai',
  'https://www.rivven.ai',
  'https://sanchezelevationai.netlify.app',
  'http://localhost:3000',
  'http://localhost:8888'
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://rivven.ai';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function sbGet(path) {
  if (!SB_URL || !SB_KEY) return null;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('sbGet', res.status, path, txt.slice(0, 200));
    return null;
  }
  return res.json().catch(() => null);
}

async function getStats() {
  const [sessions, active24h, captured, recentMsgs] = await Promise.all([
    sbGet('chat_sessions?select=count'),
    sbGet(`chat_sessions?select=count&last_seen_at=gte.${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`),
    sbGet('chat_sessions?select=count&or=(lead_phone.not.is.null,lead_email.not.is.null)'),
    sbGet(`chat_messages?select=count&created_at=gte.${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`)
  ]);

  const extractCount = (r) => Array.isArray(r) && r[0] && r[0].count != null ? r[0].count : 0;

  return {
    total_sessions: extractCount(sessions),
    active_24h: extractCount(active24h),
    leads_captured: extractCount(captured),
    messages_24h: extractCount(recentMsgs)
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...cors, ...JSON_HEADERS },
      body: JSON.stringify({ error: 'GET only' })
    };
  }

  // Auth: require admin token when one is configured. Fail-closed if the
  // env var is set but the header is missing or wrong.
  const providedToken = event.headers['x-admin-token'] || event.headers['X-Admin-Token'] || '';
  if (ADMIN_TOKEN && providedToken !== ADMIN_TOKEN) {
    return {
      statusCode: 401,
      headers: { ...cors, ...JSON_HEADERS },
      body: JSON.stringify({ error: 'unauthorized' })
    };
  }

  const params = event.queryStringParameters || {};
  const mode = (params.mode || 'sessions').slice(0, 20);

  try {
    if (mode === 'sessions') {
      const limit = Math.min(parseInt(params.limit, 10) || 50, 200);
      const data = await sbGet(`v_chat_sessions_admin?limit=${limit}`);
      return {
        statusCode: 200,
        headers: { ...cors, ...JSON_HEADERS },
        body: JSON.stringify({ sessions: data || [] })
      };
    }

    if (mode === 'messages') {
      const sid = (params.session_id || '').slice(0, 128);
      if (!sid) {
        return {
          statusCode: 400,
          headers: { ...cors, ...JSON_HEADERS },
          body: JSON.stringify({ error: 'session_id required' })
        };
      }
      const data = await sbGet(`chat_messages?session_id=eq.${encodeURIComponent(sid)}&order=created_at.asc&limit=200`);
      const sess = await sbGet(`chat_sessions?id=eq.${encodeURIComponent(sid)}&limit=1`);
      return {
        statusCode: 200,
        headers: { ...cors, ...JSON_HEADERS },
        body: JSON.stringify({
          session: (Array.isArray(sess) && sess[0]) ? sess[0] : null,
          messages: data || []
        })
      };
    }

    if (mode === 'stats') {
      const stats = await getStats();
      return {
        statusCode: 200,
        headers: { ...cors, ...JSON_HEADERS },
        body: JSON.stringify({ stats })
      };
    }

    return {
      statusCode: 400,
      headers: { ...cors, ...JSON_HEADERS },
      body: JSON.stringify({ error: 'unknown mode' })
    };
  } catch (err) {
    console.error('chat-admin error', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, ...JSON_HEADERS },
      body: JSON.stringify({ error: 'internal' })
    };
  }
};
