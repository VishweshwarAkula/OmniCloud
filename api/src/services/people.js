import { pool, query } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { redis } from "../lib/redis.js";
import { mediaUrl } from "../lib/signedUrl.js";

// Face clustering (ML assign) and merges take this per-user lock, across every replica: two new
// faces of the same stranger must not each mint a person on different ML replicas.
export const facesLock = (userId) => `omni:lock:faces:${userId}`;

// Merged-away person ids → the person they were merged into. A faces job that clustered a face
// before a merge but stores it after must not resurrect the merged person.
const aliasKey = (userId) => `omni:merged:${userId}`;

async function resolveAliases(userId, faces) {
  const alias = await redis.hgetall(aliasKey(userId));
  const resolve = (id) => {
    for (let i = 0; i < 10 && alias[id]; i++) id = alias[id]; // merges can chain
    return id;
  };
  return faces.map((f) => ({ ...f, person_id: resolve(f.person_id) }));
}

// Persist faces found in one file and keep each touched person's count/cover fresh.
export async function storeFaces(userId, fileId, found) {
  const faces = await resolveAliases(userId, found);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query("select distinct person_id from faces where file_id = $1 and person_id is not null", [fileId]);
    await client.query("delete from faces where file_id = $1", [fileId]);
    for (const f of faces) {
      await client.query("insert into people (id, user_id) values ($1, $2) on conflict (id) do nothing", [f.person_id, userId]);
      await client.query(
        "insert into faces (id, user_id, file_id, person_id, bbox, score) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set person_id = excluded.person_id, bbox = excluded.bbox, score = excluded.score",
        [f.face_id, userId, fileId, f.person_id, f.bbox, f.score]
      );
    }
    await client.query("update files set faces_scanned = true where id = $1", [fileId]);
    const touched = [...new Set([...before.rows.map((r) => r.person_id), ...faces.map((f) => f.person_id)])];
    if (touched.length) await refreshPeople(client, touched);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// Must run inside a transaction. Locks the people rows first (in id order, so concurrent refreshes
// can't deadlock), then counts in a fresh statement: under READ COMMITTED that count sees every
// committed face, so two concurrent refreshes can't overwrite each other with stale numbers.
export async function refreshPeople(client, ids) {
  await client.query("select id from people where id = any($1) order by id for update", [ids]);
  await client.query(
    `update people p set
       face_count = coalesce(s.n, 0),
       cover_face_id = s.cover
     from (
       select pp.id,
              (select count(*) from faces f where f.person_id = pp.id) as n,
              (select f.id from faces f where f.person_id = pp.id order by f.score desc nulls last, f.created_at limit 1) as cover
       from people pp where pp.id = any($1)
     ) s
     where p.id = s.id`,
    [ids]
  );
  // A cluster that lost all its faces (merged/deleted) and was never named is just noise.
  await client.query("delete from people where id = any($1) and face_count = 0 and name is null", [ids]);
}

export async function listPeople(userId, { includeSingles = false, hidden = false } = {}) {
  const rows = await query(
    `select p.id, p.name, p.face_count, f.bbox, fi.id as file_id, fi.width, fi.height
     from people p
     left join faces f on f.id = p.cover_face_id
     left join files fi on fi.id = f.file_id
     where p.user_id = $1 and p.hidden = $3 and (p.name is not null or p.face_count >= $2 or $3)
     order by (p.name is null), p.face_count desc
     limit 300`,
    [userId, includeSingles ? 1 : 2, hidden]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hidden,
    faceCount: r.face_count,
    cover: r.file_id ? { thumbUrl: mediaUrl(r.file_id, "thumb"), bbox: r.bbox, width: r.width, height: r.height } : null,
  }));
}

export async function namedPeople(userId) {
  return query("select id, name from people where user_id = $1 and name is not null and not hidden", [userId]);
}

// Rename and/or hide in one statement: a request never applies only half of its changes.
export async function updatePerson(userId, id, { name, hidden } = {}) {
  const clean = name === undefined ? undefined : name?.trim().slice(0, 60) || null;
  try {
    const rows = await query(
      `update people set
         name = case when $3 then $4 else name end,
         hidden = coalesce($5, hidden)
       where id = $1 and user_id = $2 returning id`,
      [id, userId, clean !== undefined, clean ?? null, hidden ?? null]
    );
    if (!rows.length) throw new HttpError(404, "Person not found.");
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, `Someone is already called "${clean}". Merge them instead.`, "name_taken");
    throw err;
  }
}

export async function assertOwnPeople(userId, ids) {
  const unique = [...new Set(ids)];
  const owned = await query("select id from people where user_id = $1 and id = any($2)", [userId, unique]);
  if (owned.length !== unique.length) throw new HttpError(404, "Person not found.");
}

// Move every face of `sources` onto `target` (DB side; the caller also updates the face index).
export async function mergePeople(userId, target, sources) {
  const ids = [...new Set(sources)].filter((s) => s !== target);
  const owned = await query("select id, name from people where user_id = $1 and id = any($2)", [userId, [target, ...ids]]);
  if (owned.length !== ids.length + 1) throw new HttpError(404, "Person not found.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const targetRow = owned.find((p) => p.id === target);
    const fallbackName = owned.find((p) => p.id !== target && p.name)?.name;
    await client.query("update faces set person_id = $1 where person_id = any($2)", [target, ids]);
    await client.query("delete from people where id = any($1)", [ids]);
    if (!targetRow.name && fallbackName) await client.query("update people set name = $2 where id = $1", [target, fallbackName]);
    await refreshPeople(client, [target]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  if (ids.length) {
    await redis.hset(aliasKey(userId), Object.fromEntries(ids.map((id) => [id, target])));
    await redis.expire(aliasKey(userId), 7 * 86_400); // in-flight faces jobs finish long before this
  }
  return ids;
}

// Delete a file row (its faces cascade) and recount the people who were in it, atomically.
export async function deleteFileAndRecount(fileId) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query("select distinct person_id from faces where file_id = $1 and person_id is not null", [fileId]);
    await client.query("delete from files where id = $1", [fileId]);
    if (rows.length) await refreshPeople(client, rows.map((r) => r.person_id));
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
