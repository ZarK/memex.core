-- @tjalve/memex-facts, scope 'memex-facts'. See contracts/facts.md.
-- The tables live in the hub's own database (user.db, contacts.db) beside the
-- hub's other tables, so every name starts with facts_.

-- Which hub owns the database (user or contacts), so that a database of one hub
-- is never opened with the kinds of another.
CREATE TABLE facts_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The last generation that a producer wrote, per scope and partition ('' when
-- the scope has no partitions). A write with a lower generation is refused.
CREATE TABLE facts_scope (
  scope TEXT NOT NULL,
  partition TEXT NOT NULL,
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, partition)
);

-- One claim of a producer. A withdrawn claim stays, so that its key gets its
-- earlier record id when it comes back.
--  * seq orders claims by when they were first stored, so joins are stable.
--  * cluster_id is the record id that the claim's group has (before merges).
--  * record_id is the record that holds the claim now (after merges), or null
--    while its subject does not resolve.
CREATE TABLE facts_claim (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  partition TEXT,
  kind TEXT NOT NULL,
  subject TEXT,
  other TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  method TEXT NOT NULL,
  generation INTEGER NOT NULL,
  seen_first TEXT,
  seen_last TEXT,
  fields TEXT NOT NULL CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  sources TEXT NOT NULL CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('active', 'withdrawn')),
  person TEXT,
  cluster_id TEXT,
  record_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, key)
);

CREATE INDEX idx_facts_claim_kind ON facts_claim(kind, state);
CREATE INDEX idx_facts_claim_scope ON facts_claim(scope, partition, state);
CREATE INDEX idx_facts_claim_record ON facts_claim(record_id);

-- A correction of the person, stored once by its id. body is the correction
-- as the API returns it (with anchors); extra holds what only the engine
-- reads (anchors per record, the resolved person of a create, a held reason).
CREATE TABLE facts_correction (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  op TEXT NOT NULL,
  record TEXT,
  sort_at TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  extra TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra)),
  stored_at TEXT NOT NULL
);

CREATE INDEX idx_facts_correction_order ON facts_correction(sort_at, seq);
CREATE INDEX idx_facts_correction_record ON facts_correction(record);

-- The new id of a create that repeated an earlier create: a later send of
-- that id is a repeat of the earlier correction.
CREATE TABLE facts_correction_alias (
  id TEXT PRIMARY KEY,
  of TEXT NOT NULL REFERENCES facts_correction(id)
);

-- The records as the engine made them last. A removed record stays, so that a
-- correction for it is held as record-removed and applies when it comes back.
CREATE TABLE facts_record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  person TEXT,
  version INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1)),
  merged_into TEXT,
  start_key TEXT,
  sort_name TEXT,
  body TEXT NOT NULL CHECK (json_valid(body)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_facts_record_kind ON facts_record(kind, removed);
CREATE INDEX idx_facts_record_person ON facts_record(person);

-- The change feed, written in the transaction of the change.
CREATE TABLE facts_change (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'remove')),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  person TEXT,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  record TEXT,
  merged_into TEXT
);

CREATE INDEX idx_facts_change_kind ON facts_change(kind, seq);

-- Each write that changed something, and the result of a write with an
-- idempotency key, so that a repeat returns the first result.
CREATE TABLE facts_write (
  change_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claims', 'corrections')),
  idempotency_key TEXT UNIQUE,
  result TEXT NOT NULL CHECK (json_valid(result)),
  at TEXT NOT NULL
);
