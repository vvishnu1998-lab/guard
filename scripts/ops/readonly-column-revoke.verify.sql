-- readonly-column-revoke.verify.sql
--
-- Run AFTER readonly-column-revoke.sql. Expected result for every row:
--   should_be_false = f   (the credential column is NOT readable)
--   should_be_true  = t   (an ordinary column still IS readable)
--
-- Any t under should_be_false means a credential column is still readable by
-- claude_readonly and the revoke did not take. Stop and investigate.
--
-- has_column_privilege is used rather than a live SELECT because an empty
-- table returns zero rows either way -- password_reset_tokens has 0 rows in
-- production, so a row-based test there proves nothing.
--
-- Each row is guarded on the table existing. has_column_privilege RAISES on a
-- missing relation rather than returning null, which aborted this script on
-- any database lacking password_reset_tokens -- that table is in production
-- but in no migration (N15). A missing table reports 'SKIPPED (absent)'.

SELECT 'guards.password_hash' AS target,
       CASE WHEN to_regclass('public.guards') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guards','password_hash','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.guards') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guards','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.guards') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'guards.tokens_not_before' AS target,
       CASE WHEN to_regclass('public.guards') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guards','tokens_not_before','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.guards') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guards','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.guards') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'company_admins.password_hash' AS target,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','company_admins','password_hash','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','company_admins','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'company_admins.tokens_not_before' AS target,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','company_admins','tokens_not_before','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','company_admins','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.company_admins') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'clients.password_hash' AS target,
       CASE WHEN to_regclass('public.clients') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','clients','password_hash','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.clients') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','clients','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.clients') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'clients.tokens_not_before' AS target,
       CASE WHEN to_regclass('public.clients') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','clients','tokens_not_before','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.clients') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','clients','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.clients') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'guard_devices.push_token' AS target,
       CASE WHEN to_regclass('public.guard_devices') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guard_devices','push_token','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.guard_devices') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','guard_devices','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.guard_devices') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'password_reset_tokens.token' AS target,
       CASE WHEN to_regclass('public.password_reset_tokens') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','password_reset_tokens','token','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.password_reset_tokens') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','password_reset_tokens','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.password_reset_tokens') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'revoked_tokens.jti' AS target,
       CASE WHEN to_regclass('public.revoked_tokens') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','revoked_tokens','jti','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.revoked_tokens') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','revoked_tokens','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.revoked_tokens') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'login_attempts.otp_hash' AS target,
       CASE WHEN to_regclass('public.login_attempts') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','login_attempts','otp_hash','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.login_attempts') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','login_attempts','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.login_attempts') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;

SELECT 'vishnu_state.tokens_not_before' AS target,
       CASE WHEN to_regclass('public.vishnu_state') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','vishnu_state','tokens_not_before','SELECT') END AS should_be_false,
       CASE WHEN to_regclass('public.vishnu_state') IS NULL THEN NULL
            ELSE has_column_privilege('claude_readonly','vishnu_state','id','SELECT') END AS should_be_true,
       CASE WHEN to_regclass('public.vishnu_state') IS NULL THEN 'SKIPPED (absent)' ELSE 'checked' END AS note;
