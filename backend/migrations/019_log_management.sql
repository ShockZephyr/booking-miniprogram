ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS source_request_id text;

CREATE INDEX IF NOT EXISTS http_logs_created_idx ON http_request_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS http_logs_request_idx ON http_request_logs(request_id);
CREATE INDEX IF NOT EXISTS http_logs_user_idx ON http_request_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS business_logs_created_idx ON business_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS business_logs_request_idx ON business_logs(request_id);
CREATE INDEX IF NOT EXISTS business_logs_user_idx ON business_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_request_idx ON audit_logs(request_id);
CREATE INDEX IF NOT EXISTS audit_logs_admin_idx ON audit_logs(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_created_idx ON client_errors(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS client_errors_request_idx ON client_errors(request_id);
CREATE INDEX IF NOT EXISTS client_errors_source_idx ON client_errors(source_request_id);
CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts(created_at DESC, id DESC);
