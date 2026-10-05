-- Folder uploads: where the file sits under OmniCloud/ in the cloud ('' = top level).
alter table files add column if not exists folder text not null default '';
create index if not exists files_user_folder_idx on files (user_id, folder);
