// Files dropped or picked with their folder ("Trips/Goa 2024"), so uploads keep the folder structure.

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

// <input webkitdirectory> gives each File a webkitRelativePath like "Trips/Goa 2024/IMG_1.jpg".
export const withFolder = (file) => ({ file, folder: dirname(file.webkitRelativePath || "") });

function readAll(reader) {
  // readEntries returns at most ~100 entries per call; keep reading until it returns none.
  return new Promise((resolve, reject) => {
    const out = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry, folder, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, folder });
  } else if (entry.isDirectory) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    for (const child of await readAll(entry.createReader())) await walk(child, path, out);
  }
}

// Must be called synchronously inside the drop handler: DataTransfer items expire after it returns.
export function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Promise.resolve([...dataTransfer.files].map((file) => ({ file, folder: "" })));
  return (async () => {
    const out = [];
    for (const entry of entries) await walk(entry, "", out);
    return out;
  })();
}
