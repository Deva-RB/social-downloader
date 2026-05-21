const express = require("express");
const { spawn, exec } = require("child_process");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait a minute." },
});

app.use("/api/", limiter);

// ── Platform Definitions ─────────────────────────────────────────────────────
const PLATFORMS = {
  instagram: {
    name: "Instagram",
    patterns: [
      /instagram\.com\/(p|reel|tv|stories)\//i,
      /instagr\.am\//i
    ],
  },

  tiktok: {
    name: "TikTok",
    patterns: [
      /tiktok\.com\/@[\w.]+\/video\//i,
      /vm\.tiktok\.com\//i,
      /vt\.tiktok\.com\//i
    ],
  },

  facebook: {
    name: "Facebook",
    patterns: [
      /facebook\.com\/.*\/videos\//i,
      /facebook\.com\/watch/i,
      /fb\.watch\//i,
      /fb\.com\//i
    ],
  },

  pinterest: {
    name: "Pinterest",
    patterns: [
      /pinterest\.(com|co\.\w+)\/pin\//i,
      /pin\.it\//i
    ],
  },

  youtube: {
    name: "YouTube",
    patterns: [
      /youtube\.com\/watch/i,
      /youtu\.be\//i,
      /youtube\.com\/shorts\//i
    ],
  },

  twitter: {
    name: "Twitter / X",
    patterns: [
      /twitter\.com\/\w+\/status\//i,
      /x\.com\/\w+\/status\//i
    ],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function detectPlatform(url) {
  for (const [key, p] of Object.entries(PLATFORMS)) {
    if (p.patterns.some((r) => r.test(url))) {
      return key;
    }
  }

  return null;
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function checkYtDlp() {
  return new Promise((resolve) => {
    exec("python3 -m yt_dlp --version", (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function friendlyError(stderr, platform) {

  if (stderr.includes("Private") || stderr.includes("private")) {
    return `This ${platform} post is private.`;
  }

  if (stderr.includes("login") || stderr.includes("Login")) {
    return `${platform} requires login for this content.`;
  }

  if (
    stderr.includes("404") ||
    stderr.includes("not found") ||
    stderr.includes("does not exist")
  ) {
    return "Post not found or deleted.";
  }

  if (
    stderr.includes("geo") ||
    stderr.includes("available in your country")
  ) {
    return "This video is geo-restricted.";
  }

  if (stderr.includes("copyright")) {
    return "This content is blocked due to copyright.";
  }

  return "Could not fetch video. Make sure the URL is correct and public.";
}

// ── API: Detect Platform ─────────────────────────────────────────────────────
app.post("/api/detect", (req, res) => {

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "URL required."
    });
  }

  const platform = detectPlatform(url);

  if (!platform) {
    return res.json({
      platform: null
    });
  }

  res.json({
    platform,
    name: PLATFORMS[platform].name
  });

});

// ── API: Video Info ──────────────────────────────────────────────────────────
app.post("/api/info", async (req, res) => {

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      error: "URL is required."
    });
  }

  const platform = detectPlatform(url);

  if (!platform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Supported: Instagram, TikTok, Facebook, Pinterest, YouTube, Twitter/X."
    });
  }

  const cleanUrl = sanitizeUrl(url);

  if (!cleanUrl) {
    return res.status(400).json({
      error: "Malformed URL."
    });
  }

  const version = await checkYtDlp();

  if (!version) {
    return res.status(500).json({
      error: "yt-dlp is not installed.",
      install: "pip install yt-dlp"
    });
  }

  const args = [
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--no-check-certificates",
    "--geo-bypass",
    cleanUrl
  ];

  let stdout = "";
  let stderr = "";

  const proc = spawn("python3", ["-m", "yt_dlp", ...args]);

  proc.stdout.on("data", (d) => {
    stdout += d.toString();
  });

  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  proc.on("close", (code) => {

    if (code !== 0 || !stdout.trim()) {

      console.error(`[${platform}] yt-dlp error:`, stderr);

      return res.status(500).json({
        error: friendlyError(stderr, PLATFORMS[platform].name)
      });
    }

    try {

      const info = JSON.parse(stdout.trim().split("\n")[0]);

      const formats = (info.formats || [])
        .filter((f) =>
          f.vcodec !== "none" &&
          f.ext !== "mhtml" &&
          f.url
        )
        .map((f) => ({
          format_id: f.format_id,
          ext: f.ext || "mp4",
          quality: f.height
            ? `${f.height}p`
            : (f.format_note || f.format_id),
          height: f.height || 0,
          filesize: f.filesize || f.filesize_approx || null,
        }))
        .sort((a, b) => b.height - a.height);

      const seen = new Set();

      const unique = formats.filter((f) => {

        const k = `${f.height}-${f.ext}`;

        if (seen.has(k)) {
          return false;
        }

        seen.add(k);

        return true;
      });

      res.json({
        platform,
        platform_name: PLATFORMS[platform].name,
        title: info.title || `${PLATFORMS[platform].name} Video`,
        thumbnail: info.thumbnail,
        uploader: info.uploader || info.channel || info.creator,
        duration: info.duration,
        like_count: info.like_count,
        view_count: info.view_count,
        upload_date: info.upload_date,
        description: info.description
          ? info.description.slice(0, 200)
          : null,
        formats: unique.slice(0, 8),
      });

    } catch (e) {

      console.log(e);

      res.status(500).json({
        error: "Failed to parse video info."
      });
    }

  });

});

// ── API: Download ────────────────────────────────────────────────────────────
app.get("/api/download", async (req, res) => {

  const { url, format_id, filename } = req.query;

  if (!url) {
    return res.status(400).json({
      error: "URL required."
    });
  }

  const platform = detectPlatform(url);

  if (!platform) {
    return res.status(400).json({
      error: "Unsupported platform."
    });
  }

  const cleanUrl = sanitizeUrl(url);

  const safeName =
    (filename || `${platform}_video`)
      .replace(/[^a-z0-9_\-]/gi, "_") + ".mp4";

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName}"`
  );

  res.setHeader("Content-Type", "video/mp4");

  res.setHeader("Access-Control-Allow-Origin", "*");

  const args = [
    "--no-playlist",
    "--no-warnings",

    "-f",
    format_id || "best[ext=mp4]/best",

    "--merge-output-format",
    "mp4",

    "-o",
    "-",

    cleanUrl,
  ];

  console.log(`⬇ [${platform}] Downloading: ${cleanUrl}`);

  const proc = spawn("python3", ["-m", "yt_dlp", ...args]);

  proc.stdout.pipe(res);

  proc.stderr.on("data", (d) => {
    console.error(`[yt-dlp]`, d.toString().trim());
  });

  req.on("close", () => {
    proc.kill();
  });

});

// ── API: Health ──────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {

  const version = await checkYtDlp();

  res.json({
    status: "ok",
    yt_dlp: version || "NOT INSTALLED",
    supported_platforms: Object.keys(PLATFORMS),
  });

});

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {

  console.log(`\n🚀 Social Video Downloader → http://localhost:${PORT}`);

  console.log(
    `📦 Platforms: ${
      Object.values(PLATFORMS)
        .map(p => p.name)
        .join(", ")
    }\n`
  );

});
