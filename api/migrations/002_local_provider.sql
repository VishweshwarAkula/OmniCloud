-- Provider 3 = local disk (files kept on the server's `library` volume).
alter table refresh_tokens drop constraint if exists refresh_tokens_provider_id_check;
alter table files drop constraint if exists files_provider_id_check;
alter table files add constraint files_provider_id_check check (provider_id in (1, 2, 3));
