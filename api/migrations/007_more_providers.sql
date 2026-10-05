-- Provider 4 = Koofr, 5 = pCloud.
alter table files drop constraint if exists files_provider_id_check;
alter table files add constraint files_provider_id_check check (provider_id in (1, 2, 3, 4, 5));
