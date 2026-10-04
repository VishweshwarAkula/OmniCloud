import { pool, query } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { mediaUrl } from "../lib/signedUrl.js";

// Persist faces found in one file and keep each touched person's count/cover fresh.
export async function storeFaces(userId, fileId, faces) {
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

export async function refreshPeople(client, ids) {
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

export async function renamePerson(userId, id, name) {
  const clean = name?.trim().slice(0, 60) || null;
  try {
    const rows = await query("update people set name = $3 where id = $1 and user_id = $2 returning id", [id, userId, clean]);
    if (!rows.length) throw new HttpError(404, "Person not found.");
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, `Someone is already called "${clean}". Merge them instead.`, "name_taken");
    throw err;
  }
}

export async function setHidden(userId, id, hidden) {
  const rows = await query("update people set hidden = $3 where id = $1 and user_id = $2 returning id", [id, userId, hidden]);
  if (!rows.length) throw new HttpError(404, "Person not found.");
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
  return ids;
}

// Call after deleting files: recount (or drop) the people whose faces were in them.
export async function refreshPeopleOfFile(personIds) {
  if (!personIds.length) return;
  const client = await pool.connect();
  try {
    await refreshPeople(client, personIds);
  } finally {
    client.release();
  }
}
