-- Documents (PDF, DOCX, TXT, MD) live in the same files table as images.
alter table files
  add column media_type text not null default 'image' check (media_type in ('image', 'document')),
  add column title      text,
  add column page_count integer,
  add column excerpt    text;
create index files_user_media_idx on files (user_id, media_type, created_at desc);
