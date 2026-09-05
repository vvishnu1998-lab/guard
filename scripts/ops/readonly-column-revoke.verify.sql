-- readonly-column-revoke.verify.sql
--
-- Run AFTER readonly-column-revoke.sql. Expected result: every should_be_false
-- column is f, every should_be_true column is t. Any t in a should_be_false
-- column means the revoke did not take and a credential column is still
-- readable by claude_readonly.
--
-- has_column_privilege is used rather than a live SELECT because an empty
-- table returns zero rows either way -- password_reset_tokens is empty in
-- production, so a row-based test there proves nothing.


SELECT 'guards' AS table_name,
       has_column_privilege('claude_readonly','guards','password_hash','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','guards','id','SELECT')    AS should_be_true;

SELECT 'company_admins' AS table_name,
       has_column_privilege('claude_readonly','company_admins','password_hash','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','company_admins','id','SELECT')    AS should_be_true;

SELECT 'clients' AS table_name,
       has_column_privilege('claude_readonly','clients','password_hash','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','clients','id','SELECT')    AS should_be_true;

SELECT 'guard_devices' AS table_name,
       has_column_privilege('claude_readonly','guard_devices','push_token','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','guard_devices','id','SELECT')    AS should_be_true;

SELECT 'password_reset_tokens' AS table_name,
       has_column_privilege('claude_readonly','password_reset_tokens','token','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','password_reset_tokens','id','SELECT')    AS should_be_true;

SELECT 'revoked_tokens' AS table_name,
       has_column_privilege('claude_readonly','revoked_tokens','jti','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','revoked_tokens','id','SELECT')    AS should_be_true;

SELECT 'login_attempts' AS table_name,
       has_column_privilege('claude_readonly','login_attempts','otp_hash','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','login_attempts','id','SELECT')    AS should_be_true;

SELECT 'vishnu_state' AS table_name,
       has_column_privilege('claude_readonly','vishnu_state','tokens_not_before','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','vishnu_state','id','SELECT')    AS should_be_true;

SELECT 'guards' AS table_name,
       has_column_privilege('claude_readonly','guards','tokens_not_before','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','guards','id','SELECT')  AS should_be_true;

SELECT 'company_admins' AS table_name,
       has_column_privilege('claude_readonly','company_admins','tokens_not_before','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','company_admins','id','SELECT')  AS should_be_true;

SELECT 'clients' AS table_name,
       has_column_privilege('claude_readonly','clients','tokens_not_before','SELECT') AS should_be_false,
       has_column_privilege('claude_readonly','clients','id','SELECT')  AS should_be_true;
