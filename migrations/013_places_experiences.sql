-- Private, workspace-owned place records and independently editable trip versions.
CREATE TABLE IF NOT EXISTS places (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  user_id integer NOT NULL REFERENCES users(id),
  attachment_block_id text UNIQUE REFERENCES blocks(id),
  merged_into uuid REFERENCES places(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS places_owner ON places(workspace_id, user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS place_trips (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  user_id integer NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS place_trips_owner ON place_trips(workspace_id, user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS place_trip_projections (
  trip_id uuid NOT NULL REFERENCES place_trips(id),
  stop_id uuid NOT NULL,
  block_id text UNIQUE REFERENCES blocks(id) ON DELETE SET NULL,
  applied_fingerprint text NOT NULL,
  PRIMARY KEY (trip_id, stop_id)
);
CREATE TABLE IF NOT EXISTS place_mutations (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  user_id integer NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, request_id)
);
ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE place_trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE place_trip_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE place_mutations ENABLE ROW LEVEL SECURITY;
