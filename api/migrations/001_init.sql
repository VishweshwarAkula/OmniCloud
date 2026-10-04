create extension if not exists pgcrypto;

create table users (
  id          uuid primary key default gen_random_uuid(),
  google_sub  text unique,
  email       text not null unique,
  name        text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  last_login_at timestamptz
);

-- OAuth refresh tokens for storage providers, AES-256-GCM encrypted by the API ("v1:" prefix).
create table refresh_tokens (
  user_id       uuid     not null references users (id) on delete cascade,
  provider_id   smallint not null check (provider_id in (1, 2)),  -- 1 = gdrive, 2 = dropbox
  refresh_token text     not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, provider_id)
);

create table files (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,
  file_hash        text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  provider_id      smallint not null check (provider_id in (1, 2)),
  provider_file_id text,
  name             text,
  mime             text,
  size             bigint,
  weaviate_id      text,
  status           text not null default 'indexing' check (status in ('indexing', 'ready', 'failed')),
  created_at       timestamptz not null default now(),
  unique (user_id, file_hash)
);
create index files_user_created_idx on files (user_id, created_at desc, id desc);

create table receipts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  file_id      uuid not null unique references files (id) on delete cascade,
  total        numeric(14, 2),
  currency     text,
  vendor       text,
  receipt_date date,
  confidence   real,
  raw          jsonb,
  created_at   timestamptz not null default now()
);
create index receipts_user_date_idx on receipts (user_id, receipt_date desc);
