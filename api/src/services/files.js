import { one, PROVIDER_KEYS, query } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { mediaUrl } from "../lib/signedUrl.js";

const COLUMNS =
  "id, user_id, file_hash, provider_id, provider_file_id, name, mime, size, status, created_at, " +
  "taken_at, width, height, camera, kind, tags, embed_model, place_name, place_city, place_country, " +
  "media_type, title, page_count, excerpt, folder, " +
  "(select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name) order by p.name), '[]') " +
  " from faces f join people p on p.id = f.person_id where f.file_id = files.id and not p.hidden) as people";

export function serializeFile(row, extra = {}) {
  const viewable = Boolean(row.provider_file_id) && row.status !== "failed";
  return {
    id: row.id,
    hash: row.file_hash,
    name: row.name,
    mime: row.mime,
    size: row.size,
    provider: PROVIDER_KEYS[row.provider_id],
    status: row.status,
    createdAt: row.created_at,
    takenAt: row.taken_at,
    width: row.width,
    height: row.height,
    camera: row.camera,
    kind: row.kind,
    tags: row.tags ?? [],
    place: row.place_name ?? null,
    mediaType: row.media_type ?? "image",
    title: row.title ?? null,
    pageCount: row.page_count ?? null,
    excerpt: row.excerpt ?? null,
    folder: row.folder || null,
    people: row.people ?? [],
    thumbUrl: viewable && row.media_type !== "document" ? mediaUrl(row.id, "thumb") : null,
    url: viewable ? mediaUrl(row.id, "full") : null,
    ...extra,
  };
}

export const findByHash = (userId, fileHash) =>
  one(`select ${COLUMNS} from files where user_id = $1 and file_hash = $2`, [userId, fileHash]);

export const getFile = (id) => one(`select ${COLUMNS} from files where id = $1`, [id]);

const encodeCursor = (row) => Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString("base64url");
function decodeCursor(cursor) {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new HttpError(400, "Invalid cursor.");
  return [ts, id];
}

// Keyset pagination on (created_at, id): stable under inserts and served by files_user_created_idx.
export async function listFiles(userId, { limit = 30, cursor, tag, person, folder } = {}) {
  const params = [userId, limit + 1];
  let where = "user_id = $1 and status <> 'failed' and provider_file_id is not null";
  if (tag) {
    params.push(tag);
    where += ` and tags @> array[$${params.length}]::text[]`; // served by the GIN index
  }
  if (person) {
    params.push(person);
    where += ` and exists (select 1 from faces f where f.file_id = files.id and f.person_id = $${params.length})`;
  }
  if (folder) {
    // A folder includes its subfolders.
    params.push(folder, `${folder.replace(/[\\%_]/g, "\\$&")}/%`);
    where += ` and (folder = $${params.length - 1} or folder like $${params.length})`;
  }
  if (cursor) {
    const [ts, id] = decodeCursor(cursor);
    params.push(ts, id);
    where += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const rows = await query(`select ${COLUMNS} from files where ${where} order by created_at desc, id desc limit $2`, params);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => serializeFile(r)),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
  };
}

export const filesByHashes = (userId, hashes) =>
  hashes.length ? query(`select ${COLUMNS} from files where user_id = $1 and file_hash = any($2)`, [userId, hashes]) : [];

export const upsertFile = (r) =>
  one(
    `insert into files (user_id, file_hash, provider_id, provider_file_id, name, mime, size, status, media_type, folder)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (user_id, file_hash) do update
       set provider_id = excluded.provider_id, provider_file_id = excluded.provider_file_id,
           name = excluded.name, mime = excluded.mime, size = excluded.size, status = excluded.status,
           media_type = excluded.media_type, folder = excluded.folder
     returning ${COLUMNS}`,
    [r.user_id, r.file_hash, r.provider_id, r.provider_file_id, r.name, r.mime, r.size, r.status, r.media_type ?? "image", r.folder ?? ""]
  );

const UPDATABLE = new Set([
  "weaviate_id", "status", "provider_file_id", "taken_at", "width", "height", "camera", "lat", "lon",
  "kind", "tags", "tag_scores", "embed_model", "place_name", "place_area", "place_city", "place_region",
  "place_country", "media_type", "title", "page_count", "excerpt",
]);

export async function updateFile(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((k) => !UPDATABLE.has(k))) throw new Error(`updateFile: bad fields ${keys}`);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await query(`update files set ${sets} where id = $1`, [id, ...keys.map((k) => patch[k])]);
}


// Most common tags across the user's library, for filter chips.
export const topTags = (userId, limit = 16) =>
  query(
    `select tag, count(*)::int as count from files, unnest(tags) as tag
     where user_id = $1 and status <> 'failed' group by tag order by count desc, tag limit $2`,
    [userId, limit]
  );

// Top-level uploaded folders with their file counts (subfolders included), for filter chips.
export const topFolders = (userId, limit = 24) =>
  query(
    `select split_part(folder, '/', 1) as folder, count(*)::int as count from files
     where user_id = $1 and folder <> '' and status <> 'failed' and provider_file_id is not null
     group by 1 order by count desc, 1 limit $2`,
    [userId, limit]
  );

// Flattens the ML service's metadata into file columns.
export const metadataPatch = (m, model) => ({
  taken_at: m?.taken_at ?? null,
  width: m?.width ?? null,
  height: m?.height ?? null,
  camera: m?.camera ?? null,
  lat: m?.lat ?? null,
  lon: m?.lon ?? null,
  kind: m?.kind ?? null,
  tags: (m?.tags ?? []).map((t) => t.label),
  tag_scores: m?.tags ? JSON.stringify(m.tags) : null,
  embed_model: model ?? null,
  place_name: m?.place?.name ?? null,
  place_area: m?.place?.area ?? null,
  place_city: m?.place?.city ?? null,
  place_region: m?.place?.region ?? null,
  place_country: m?.place?.country ?? null,
});

// Distinct place names the user has photos from (grounding for query understanding).
export async function knownPlaces(userId) {
  const rows = await query(
    `select distinct unnest(array[place_area, place_city, place_region, place_country]) as p
     from files where user_id = $1 and place_name is not null`,
    [userId]
  );
  return rows.map((r) => r.p).filter(Boolean);
}

/*
  Resolve structured filters to the file hashes that satisfy them.
  Returns null when there are no filters (= search everything).
*/
export async function filterHashes(userId, { dateFrom, dateTo, months, kinds, places, personIds }, limit = 5000) {
  const where = ["user_id = $1", "status <> 'failed'", "provider_file_id is not null"];
  const params = [userId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  // Capture time when known, otherwise upload time.
  if (dateFrom) add("coalesce(taken_at, created_at) >= $?::date", dateFrom);
  if (dateTo) add("coalesce(taken_at, created_at) < ($?::date + 1)", dateTo);
  if (months?.length) add("extract(month from coalesce(taken_at, created_at))::int = any($?)", months);
  if (kinds?.length) add("kind = any($?)", kinds);
  if (places?.length)
    add(
      "(place_area ilike any($?) or place_city ilike any($?) or place_region ilike any($?) or place_country ilike any($?))",
      places
    );
  for (const pid of personIds ?? [])
    add("exists (select 1 from faces f where f.file_id = files.id and f.person_id = $?)", pid);
  if (where.length === 3) return null;
  params.push(limit);
  const rows = await query(
    `select file_hash from files where ${where.join(" and ")} order by coalesce(taken_at, created_at) desc limit $${params.length}`,
    params
  );
  return rows.map((r) => r.file_hash);
}
