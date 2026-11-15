-- Additive MCP access boundary schema. No grants or account data are migrated.

CREATE TABLE IF NOT EXISTS mcp_connections (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, client_id TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 scopes JSONB NOT NULL, scope_limit JSONB, pending_scopes JSONB, upgrade_after TIMESTAMPTZ, profile_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_verified_at TIMESTAMPTZ,
 authorized_after TIMESTAMPTZ, revoked_at TIMESTAMPTZ, revocation_pending BOOLEAN NOT NULL DEFAULT FALSE,
 UNIQUE(issuer,subject,client_id)
);
CREATE TABLE IF NOT EXISTS mcp_connection_tokens (
 token_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
 token_enc TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connection_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mcp_connections,mcp_connection_tokens FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON mcp_connections,mcp_connection_tokens FROM %I',r);
 END LOOP;
END $privacy$;

CREATE TABLE IF NOT EXISTS mcp_approvals (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connection_id TEXT NOT NULL, operation TEXT NOT NULL, payload JSONB NOT NULL, payload_hash TEXT NOT NULL,
 manifest JSONB NOT NULL, scopes JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,workspace_id,connection_id,payload_hash)
);
CREATE TABLE IF NOT EXISTS mcp_action_log (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connection_id TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, approval_id TEXT, affected_ids JSONB NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE mcp_action_log ADD COLUMN IF NOT EXISTS affected_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE mcp_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_action_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mcp_approvals,mcp_action_log FROM PUBLIC;
DO $privacy$ DECLARE r TEXT; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
 EXECUTE format('REVOKE ALL ON mcp_approvals,mcp_action_log FROM %I',r);
 END LOOP;
END $privacy$;
CREATE TABLE IF NOT EXISTS service_tokens (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        user_id INTEGER REFERENCES users(id), workspace_id TEXT REFERENCES workspaces(id), actions JSONB
      );
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id);
      ALTER TABLE service_tokens ADD COLUMN IF NOT EXISTS actions JSONB;
      ALTER TABLE service_tokens ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON service_tokens FROM PUBLIC;
      DO $service_privacy$ DECLARE r TEXT; BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
          EXECUTE format('REVOKE ALL ON service_tokens FROM %I',r);
        END LOOP;
      END $service_privacy$;