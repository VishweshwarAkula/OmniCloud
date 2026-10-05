// Single-user app: every request acts as the one local owner.
// Resolved once: OWNER_EMAIL if set, else the oldest user, else a fresh local account.
import { config } from "../config.js";
import { one } from "../db/index.js";

let cached = null;

const toUser = (u) => ({ id: u.id, email: u.email, name: u.name, avatar: u.avatar_url, createdAt: u.created_at });

export async function getOwner() {
  if (cached) return cached;
  const row =
    (config.OWNER_EMAIL && (await one("select * from users where email = lower($1)", [config.OWNER_EMAIL]))) ||
    (await one("select * from users order by created_at limit 1")) ||
    // Two first requests at once must not both insert: the second gets the same row back.
    (await one(
      `insert into users (email, name) values ('local@omnicloud', 'You')
       on conflict (email) do update set email = excluded.email returning *`
    ));
  cached = toUser(row);
  return cached;
}

export function forgetOwner() {
  cached = null;
}
