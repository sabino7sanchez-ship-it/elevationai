-- ==================================================================
-- _chat_schema.sql — Supabase schema for RIVVEN AI Chat
-- ------------------------------------------------------------------
-- Run once against the Supabase project `inhnfdoyjjadihoampqs`:
--   1. Go to https://supabase.com/dashboard/project/inhnfdoyjjadihoampqs/sql
--   2. Paste this file contents, click Run
--
-- Idempotent: uses CREATE TABLE IF NOT EXISTS. Re-running is safe.
-- ==================================================================

-- ── chat_sessions ────────────────────────────────────────────────
-- One row per browser session. `id` is the client-generated UUID
-- stored in localStorage. No user auth — anonymous by design.
CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id              text PRIMARY KEY,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Convenience surface for admin dashboard (populated opportunistically
    -- by chat.js when the model extracts lead_info from the conversation).
    lead_name       text,
    lead_phone      text,
    lead_email      text,
    lead_industry   text,
    lead_budget     text,

    -- Denormalized message counts for quick admin list rendering.
    msg_count_user       int NOT NULL DEFAULT 0,
    msg_count_assistant  int NOT NULL DEFAULT 0,
    last_intent          text,
    last_language        text,

    -- Cost tracking
    tokens_in_total      int NOT NULL DEFAULT 0,
    tokens_out_total     int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_seen  ON public.chat_sessions(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead_phone ON public.chat_sessions(lead_phone) WHERE lead_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead_email ON public.chat_sessions(lead_email) WHERE lead_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_meta_gin   ON public.chat_sessions USING gin (meta);

-- ── chat_messages ────────────────────────────────────────────────
-- One row per message exchanged. Rate limiting uses a COUNT on this
-- table filtered by session_id + created_at ≥ (now - 1h) + role='user'.
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id              bigserial PRIMARY KEY,
    session_id      text NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         text NOT NULL,

    -- Metadata populated for assistant messages (null for user messages)
    intent          text,
    language        text,
    model           text,
    tokens_in       int,
    tokens_out      int,
    actions         jsonb,    -- array of {type, label, url?, context?}

    -- Flags
    is_fallback     boolean NOT NULL DEFAULT false,
    is_error        boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session       ON public.chat_messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created       ON public.chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_rate_limit    ON public.chat_messages(session_id, role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_actions_gin   ON public.chat_messages USING gin (actions);

-- ── Row-Level Security ───────────────────────────────────────────
-- Both tables are locked down. Only the service_role key (used by the
-- Netlify function) can read/write. The public anon key cannot touch
-- these tables — the chat widget talks to the Netlify function, not
-- Supabase directly.
ALTER TABLE public.chat_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages  ENABLE ROW LEVEL SECURITY;

-- Explicit deny for anon role (RLS on with no policy = deny, but we
-- make it crystal clear with a named policy that anon can't SELECT).
DROP POLICY IF EXISTS "deny_anon_sessions" ON public.chat_sessions;
CREATE POLICY "deny_anon_sessions"
    ON public.chat_sessions
    FOR ALL
    TO anon
    USING (false);

DROP POLICY IF EXISTS "deny_anon_messages" ON public.chat_messages;
CREATE POLICY "deny_anon_messages"
    ON public.chat_messages
    FOR ALL
    TO anon
    USING (false);

-- service_role bypasses RLS automatically — no policy needed.

-- ── Trigger: auto-update chat_sessions counters on new messages ──
CREATE OR REPLACE FUNCTION public.fn_chat_touch_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.chat_sessions
    SET last_seen_at = now(),
        msg_count_user      = msg_count_user      + CASE WHEN NEW.role = 'user'      THEN 1 ELSE 0 END,
        msg_count_assistant = msg_count_assistant + CASE WHEN NEW.role = 'assistant' THEN 1 ELSE 0 END,
        tokens_in_total     = tokens_in_total     + COALESCE(NEW.tokens_in,  0),
        tokens_out_total    = tokens_out_total    + COALESCE(NEW.tokens_out, 0),
        last_intent         = COALESCE(NEW.intent,   last_intent),
        last_language       = COALESCE(NEW.language, last_language)
    WHERE id = NEW.session_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_touch_session ON public.chat_messages;
CREATE TRIGGER trg_chat_touch_session
    AFTER INSERT ON public.chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_chat_touch_session();

-- ── View: admin-friendly session list with preview ───────────────
CREATE OR REPLACE VIEW public.v_chat_sessions_admin AS
SELECT
    s.id,
    s.created_at,
    s.last_seen_at,
    s.meta,
    s.lead_name,
    s.lead_phone,
    s.lead_email,
    s.lead_industry,
    s.lead_budget,
    s.msg_count_user,
    s.msg_count_assistant,
    s.last_intent,
    s.last_language,
    s.tokens_in_total,
    s.tokens_out_total,
    (
        SELECT content
        FROM public.chat_messages m
        WHERE m.session_id = s.id AND m.role = 'user'
        ORDER BY m.created_at DESC
        LIMIT 1
    ) AS last_user_message,
    (
        SELECT content
        FROM public.chat_messages m
        WHERE m.session_id = s.id AND m.role = 'user'
        ORDER BY m.created_at ASC
        LIMIT 1
    ) AS first_user_message
FROM public.chat_sessions s
ORDER BY s.last_seen_at DESC;

COMMENT ON TABLE public.chat_sessions IS 'RIVVEN AI chat widget — browser sessions (anonymous)';
COMMENT ON TABLE public.chat_messages IS 'RIVVEN AI chat widget — individual messages within sessions';
COMMENT ON VIEW  public.v_chat_sessions_admin IS 'Admin dashboard feed: chat sessions with first/last message preview';
