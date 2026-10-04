-- Metadata and zero-shot classification produced by the vision model at index time.
alter table files
  add column taken_at    timestamptz,
  add column width       integer,
  add column height      integer,
  add column camera      text,
  add column lat         double precision,
  add column lon         double precision,
  add column kind        text,
  add column tags        text[] not null default '{}',
  add column tag_scores  jsonb,
  add column embed_model text;

create index files_tags_idx on files using gin (tags);
create index files_user_kind_idx on files (user_id, kind);
