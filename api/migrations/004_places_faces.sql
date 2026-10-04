-- Place names from reverse geocoding.
alter table files
  add column place_name    text,
  add column place_area    text,
  add column place_city    text,
  add column place_region  text,
  add column place_country text,
  add column faces_scanned boolean not null default false;
create index files_user_place_idx on files (user_id, place_city, place_country);
create index files_user_taken_idx on files (user_id, taken_at desc);

-- People = clusters of faces. Ids come from the ML service's incremental clustering.
create table people (
  id           uuid primary key,
  user_id      uuid not null references users (id) on delete cascade,
  name         text,
  cover_face_id uuid,
  face_count   integer not null default 0,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);
create index people_user_idx on people (user_id, face_count desc);
create unique index people_user_name_idx on people (user_id, lower(name)) where name is not null;

create table faces (
  id         uuid primary key,
  user_id    uuid not null references users (id) on delete cascade,
  file_id    uuid not null references files (id) on delete cascade,
  person_id  uuid references people (id) on delete set null,
  bbox       real[] not null,   -- normalised [x, y, w, h]
  score      real,
  created_at timestamptz not null default now()
);
create index faces_person_idx on faces (user_id, person_id);
create index faces_file_idx on faces (file_id);
