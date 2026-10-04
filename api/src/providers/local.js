import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { UpstreamError } from "./http.js";

// Stores files on the server's own `library` volume — no third-party account needed.
const root = () => config.LIBRARY_DIR;
const safeId = (id) => {
  const p = path.resolve(root(), id);
  if (!p.startsWith(path.resolve(root()) + path.sep)) throw new UpstreamError(400, "bad path", "local://");
  return p;
};
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif", ".bmp": "image/bmp", ".tiff": "image/tiff" };

function fileResponse(id) {
  const p = safeId(id);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new UpstreamError(404, "not found", "local://");
  }
  return new Response(Readable.toWeb(fs.createReadStream(p)), {
    headers: { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "content-length": String(stat.size) },
  });
}

export const local = {
  key: "local",
  label: "Local disk",
  local: true,

  async quota() {
    const s = await fs.promises.statfs(root());
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, used: total - free, free };
  },

  async upload(_at, { name, buffer, userId }) {
    const id = `${userId}/${name}`;
    const p = safeId(id);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    // Write-then-rename so readers never see a half-written file.
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, p);
    return { id, name };
  },

  media: (_at, id) => fileResponse(id),
  thumbnail: (_at, id) => fileResponse(id),

  async remove(_at, id) {
    await fs.promises.unlink(safeId(id)).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
  },
};
