import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const assetsRoot = path.join(repoRoot, "assets");
const manifestPath = path.join(assetsRoot, "cases-manifest.json");

const groups = [
  ["long", "Long Video Cases"],
  ["short", "Short Clip Cases"],
];

const videoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const posterExtensions = [".jpg", ".jpeg", ".png", ".webp"];

function titleFromFilename(filename) {
  const parsed = path.parse(filename);
  return parsed.name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function typeFromExtension(extension) {
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  return "video/mp4";
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function findPoster(groupDir, basename) {
  for (const extension of posterExtensions) {
    const filename = `${basename}${extension}`;
    if (await exists(path.join(groupDir, filename))) {
      return filename;
    }
  }
  return null;
}

async function collectVideos(groupDir, currentDir = groupDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const videos = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      videos.push(...(await collectVideos(groupDir, fullPath)));
      continue;
    }

    if (entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase())) {
      videos.push(path.relative(groupDir, fullPath));
    }
  }

  return videos.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function scanGroup(key, label) {
  const groupDir = path.join(assetsRoot, key);
  await mkdir(groupDir, { recursive: true });

  const videos = await collectVideos(groupDir);

  const items = [];
  for (const relativeFile of videos) {
    const parsed = path.parse(relativeFile);
    const relativeDir = parsed.dir ? `${parsed.dir}/` : "";
    const poster = await findPoster(path.join(groupDir, parsed.dir), parsed.name);
    const basePath = `./assets/${key}/${relativeDir}`.replaceAll(path.sep, "/");
    items.push({
      title: titleFromFilename(parsed.name),
      description: `${label} preview from assets/${key}.`,
      src: `${basePath}${parsed.base}`,
      poster: poster ? `${basePath}${poster}` : "",
      type: typeFromExtension(parsed.ext.toLowerCase()),
    });
  }

  return items;
}

const manifest = {
  schemaVersion: 1,
  groups: Object.fromEntries(await Promise.all(groups.map(async ([key, label]) => [key, await scanGroup(key, label)]))),
};

await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(`${manifestPath}.tmp`, manifestPath);

const total = Object.values(manifest.groups).reduce((sum, items) => sum + items.length, 0);
console.log(`Wrote assets/cases-manifest.json with ${total} video(s).`);
