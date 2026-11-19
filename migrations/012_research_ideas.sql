-- Additive Research & Ideas. Re-runnable; existing rows remain untouched.

CREATE TABLE IF NOT EXISTS research_records (
  id UUID PRIMARY KEY REFERENCES wishlists(id),
  kind TEXT NOT NULL CHECK(kind IN ('idea','research','requirement','product'))
);
CREATE TABLE IF NOT EXISTS wishlist_revisions (
  sequence BIGSERIAL PRIMARY KEY,
  wishlist_id UUID NOT NULL REFERENCES wishlists(id),
  kind TEXT NOT NULL,
  record_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  data JSONB NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(wishlist_id,kind,record_id,revision)
);
CREATE INDEX IF NOT EXISTS wishlist_revisions_recent ON wishlist_revisions(wishlist_id,sequence DESC);
CREATE TABLE IF NOT EXISTS research_links (
  id UUID PRIMARY KEY,
  from_id UUID NOT NULL REFERENCES wishlists(id),
  to_id UUID REFERENCES wishlists(id),
  block_id TEXT REFERENCES blocks(id),
  relation TEXT NOT NULL CHECK(relation IN ('related','research','requires','candidate','task','project')),
  data JSONB NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((to_id IS NOT NULL)::int + (block_id IS NOT NULL)::int = 1),
  CHECK (from_id IS DISTINCT FROM to_id),
  CHECK ((block_id IS NOT NULL) = (relation IN ('task','project')))
);
CREATE UNIQUE INDEX IF NOT EXISTS research_links_records ON research_links
  (LEAST(from_id,to_id),GREATEST(from_id,to_id),relation) WHERE to_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS research_links_blocks ON research_links(from_id,block_id,relation) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS research_links_reverse ON research_links(to_id) WHERE active;
CREATE INDEX IF NOT EXISTS research_links_block_reverse ON research_links(block_id) WHERE active;
CREATE TABLE IF NOT EXISTS research_entries (
  id UUID PRIMARY KEY,
  record_id UUID NOT NULL REFERENCES wishlists(id),
  data JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_entries_record ON research_entries(record_id,created_at,id);
CREATE TABLE IF NOT EXISTS research_mutations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY(workspace_id,user_id,id)
);
ALTER TABLE research_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_revisions ENABLE ROW LEVEL SECURITY;

-- A foreign key proves existence. This trigger also proves relationship ownership.
CREATE OR REPLACE FUNCTION dcc_research_link_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row wishlists%ROWTYPE; target_row wishlists%ROWTYPE; target_block blocks%ROWTYPE;
BEGIN
 SELECT * INTO STRICT source_row FROM wishlists WHERE id=NEW.from_id;
 IF NEW.to_id IS NOT NULL THEN
   SELECT * INTO STRICT target_row FROM wishlists WHERE id=NEW.to_id;
   IF source_row.workspace_id<>target_row.workspace_id OR source_row.user_id<>target_row.user_id THEN
     RAISE EXCEPTION 'Relationship ownership mismatch' USING ERRCODE='23514';
   END IF;
 ELSE
   SELECT * INTO STRICT target_block FROM blocks WHERE id=NEW.block_id;
   IF source_row.workspace_id IS DISTINCT FROM target_block.workspace_id OR
     (target_block.user_id IS NOT NULL AND source_row.user_id<>target_block.user_id) THEN
     RAISE EXCEPTION 'Relationship ownership mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='research_link_owner' AND tgrelid='research_links'::regclass) THEN
   CREATE TRIGGER research_link_owner BEFORE INSERT OR UPDATE ON research_links
   FOR EACH ROW EXECUTE FUNCTION dcc_research_link_owner();
 END IF;
END $$;
