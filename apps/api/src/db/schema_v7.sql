-- v7: allow contract_end to be optional (NULL) on sites
--     and allow data_retention_log dates to be NULL when no contract_end is set
ALTER TABLE sites ALTER COLUMN contract_end DROP NOT NULL;
ALTER TABLE data_retention_log ALTER COLUMN client_star_access_until DROP NOT NULL;
ALTER TABLE data_retention_log ALTER COLUMN data_delete_at DROP NOT NULL;
