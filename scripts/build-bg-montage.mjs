import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = process.env.ECHO_DB || "/Users/gelercat/Downloads/votes.sqlite";
const workDir = process.env.ECHO_BG_WORKDIR || "/tmp/echo-bg-montage";
const videoDir = path.join(workDir, "videos");
const tmpDir = path.join(workDir, "render");
const outVideo = path.join(repoRoot, "assets", "echo-bg-grid-20s-4k.mp4");
const outPoster = path.join(repoRoot, "assets", "echo-bg-grid-20s-4k.jpg");

const cells = 9;
const segmentsPerCell = 8;
const segmentDuration = 2.5;
const duration = cells * 0 + segmentsPerCell * segmentDuration;
const fps = 24;
const tileW = 1280;
const tileH = 720;
const outW = tileW * 3;
const outH = tileH * 3;
const crf = process.env.ECHO_BG_CRF || "28";
const seed = Number(process.env.ECHO_BG_SEED || "20260520");

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.map((arg) => (String(arg).includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function runJson(command, args) {
  return JSON.parse(execFileSync(command, args, { encoding: "utf8" }));
}

function createRng(initialSeed) {
  let value = initialSeed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rng) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function safePart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

function pickOffset(durationSeconds, rng) {
  const spare = Math.max(0, durationSeconds - segmentDuration - 0.5);
  if (spare <= 0.1) return 0;
  return Number((rng() * spare).toFixed(3));
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-L",
      "--fail",
      "--retry",
      "2",
      "--connect-timeout",
      "15",
      "-sS",
      "-o",
      file,
      url,
    ];
    const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `curl exited with ${code}`));
    });
  });
}

async function downloadPool(rows, concurrency = 8) {
  let cursor = 0;
  let completed = 0;
  const failures = [];

  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      try {
        try {
          const existing = await stat(row.file);
          if (existing.size > 1024 * 100) {
            completed += 1;
            console.log(`[skip] ${completed}/${rows.length} ${path.basename(row.file)} ${(existing.size / 1048576).toFixed(1)} MiB`);
            continue;
          }
        } catch {
          // Missing file, download below.
        }

        console.log(`[get ] ${completed + 1}/${rows.length} ${row.set_id}/${row.id}`);
        await download(row.left_src, row.file);
        const size = await stat(row.file);
        completed += 1;
        console.log(`[done] ${completed}/${rows.length} ${path.basename(row.file)} ${(size.size / 1048576).toFixed(1)} MiB`);
      } catch (error) {
        completed += 1;
        failures.push({ row, error: error.message });
        console.warn(`[fail] ${completed}/${rows.length} ${row.set_id}/${row.id}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return failures;
}

function probe(file) {
  const result = runJson("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,duration",
    "-of",
    "json",
    file,
  ]);
  const stream = result.streams?.[0];
  if (!stream) return null;
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    duration: Number(stream.duration),
  };
}

function buildPlan(videos) {
  const rng = createRng(seed);
  const deck = shuffle(videos, rng);
  const slots = cells * segmentsPerCell;
  const picked = [];
  for (let i = 0; i < slots; i += 1) {
    picked.push(deck[i % deck.length]);
  }

  const plan = [];
  for (let cell = 0; cell < cells; cell += 1) {
    const cellSegments = [];
    for (let seg = 0; seg < segmentsPerCell; seg += 1) {
      const index = seg * cells + cell;
      let video = picked[index];
      if (seg > 0 && video.file === cellSegments[seg - 1].file) {
        video = deck[(index + 7) % deck.length];
      }
      cellSegments.push({
        ...video,
        offset: pickOffset(video.duration, rng),
      });
    }
    plan.push(cellSegments);
  }
  return plan;
}

function ffmpegArgsForPlan(plan, tmpVideo) {
  const inputArgs = [];
  const segmentFilters = [];
  const concatFilters = [];
  const laneLabels = [];
  let inputIndex = 0;

  for (let cell = 0; cell < plan.length; cell += 1) {
    const labels = [];
    for (let seg = 0; seg < plan[cell].length; seg += 1) {
      const item = plan[cell][seg];
      inputArgs.push("-ss", String(item.offset), "-t", String(segmentDuration), "-i", item.file);
      const label = `v${inputIndex}`;
      segmentFilters.push(
        `[${inputIndex}:v]` +
          `fps=${fps},` +
          `scale=${tileW}:${tileH}:force_original_aspect_ratio=increase,` +
          `crop=${tileW}:${tileH},` +
          "setsar=1,format=yuv420p,setpts=PTS-STARTPTS" +
          `[${label}]`,
      );
      labels.push(`[${label}]`);
      inputIndex += 1;
    }
    const lane = `lane${cell}`;
    concatFilters.push(`${labels.join("")}concat=n=${segmentsPerCell}:v=1:a=0[${lane}]`);
    laneLabels.push(`[${lane}]`);
  }

  const layout = [
    "0_0",
    `${tileW}_0`,
    `${tileW * 2}_0`,
    `0_${tileH}`,
    `${tileW}_${tileH}`,
    `${tileW * 2}_${tileH}`,
    `0_${tileH * 2}`,
    `${tileW}_${tileH * 2}`,
    `${tileW * 2}_${tileH * 2}`,
  ].join("|");

  const stackFilter = `${laneLabels.join("")}xstack=inputs=${cells}:layout=${layout}:fill=black[out]`;
  const filterComplex = [...segmentFilters, ...concatFilters, stackFilter].join(";");

  return [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[out]",
    "-an",
    "-t",
    String(duration),
    "-r",
    String(fps),
    "-s",
    `${outW}x${outH}`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    tmpVideo,
  ];
}

async function main() {
  await mkdir(videoDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const rows = runJson("sqlite3", [
    "-json",
    dbPath,
    `
      select set_id, id, sort_order, left_model, left_label, left_src
      from sample_pairs
      where left_model = 'echo_long'
      order by set_id, sort_order
    `,
  ]).map((row, index) => ({
    ...row,
    file: path.join(videoDir, `${String(index + 1).padStart(2, "0")}_${safePart(row.set_id)}_${safePart(row.id)}.mp4`),
  }));

  console.log(`Found ${rows.length} Echo videos in ${dbPath}`);
  const failures = await downloadPool(rows);
  if (failures.length) {
    console.warn(`Downloads with failures: ${failures.length}`);
  }

  const videos = [];
  for (const row of rows) {
    try {
      const info = probe(row.file);
      if (info && info.duration >= segmentDuration) {
        videos.push({ ...row, ...info });
      }
    } catch (error) {
      console.warn(`[probe fail] ${row.id}: ${error.message}`);
    }
  }

  if (videos.length < cells) {
    throw new Error(`Need at least ${cells} usable videos, got ${videos.length}`);
  }

  const plan = buildPlan(videos);
  const planRows = plan.flatMap((segments, cell) =>
    segments.map((segment, order) => ({
      cell,
      order,
      set_id: segment.set_id,
      id: segment.id,
      offset: segment.offset,
      duration: segment.duration,
      file: segment.file,
    })),
  );
  await writeFile(path.join(workDir, "montage-plan.json"), JSON.stringify(planRows, null, 2));

  const tmpVideo = path.join(tmpDir, "echo-bg-grid-20s-4k-montage.mp4");
  const tmpPoster = path.join(tmpDir, "echo-bg-grid-20s-4k-montage.jpg");
  run("ffmpeg", ffmpegArgsForPlan(plan, tmpVideo), { cwd: repoRoot });
  run("ffmpeg", ["-y", "-ss", "1", "-i", tmpVideo, "-frames:v", "1", "-q:v", "3", tmpPoster]);

  await copyFile(tmpVideo, outVideo);
  await copyFile(tmpPoster, outPoster);

  const videoSize = await stat(outVideo);
  const posterSize = await stat(outPoster);
  const unique = new Set(planRows.map((row) => `${row.set_id}/${row.id}`)).size;
  console.log(`Wrote ${outVideo} ${(videoSize.size / 1048576).toFixed(1)} MiB`);
  console.log(`Wrote ${outPoster} ${(posterSize.size / 1024).toFixed(0)} KiB`);
  console.log(`Montage slots: ${planRows.length}, unique Echo clips used: ${unique}/${videos.length}, CRF ${crf}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
