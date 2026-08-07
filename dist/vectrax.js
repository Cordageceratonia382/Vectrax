#!/usr/bin/env node

// src/bin/vectrax.ts
import { CommanderError } from "commander";

// src/cli/program.ts
import { Command, Option } from "commander";

// src/core/errors.ts
var ExitCode = {
  Ok: 0,
  Failure: 1,
  UsageError: 2,
  NetworkError: 3,
  FilesystemError: 4,
  NoResults: 5,
  PartialFailure: 6,
  Interrupted: 130
};
var VectraxError = class extends Error {
  code;
  exitCode;
  hint;
  details;
  constructor(message, options = {}) {
    super(message, options.cause !== void 0 ? { cause: options.cause } : void 0);
    this.name = "VectraxError";
    this.code = options.code ?? "E_INTERNAL";
    this.exitCode = options.exitCode ?? ExitCode.Failure;
    this.hint = options.hint;
    this.details = options.details;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...this.hint !== void 0 ? { hint: this.hint } : {},
      ...this.details !== void 0 ? { details: this.details } : {}
    };
  }
};
var UsageError = class extends VectraxError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "E_USAGE", exitCode: ExitCode.UsageError });
    this.name = "UsageError";
  }
};
var ConfigError = class extends VectraxError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "E_CONFIG", exitCode: ExitCode.UsageError });
    this.name = "ConfigError";
  }
};
var NetworkError = class extends VectraxError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "E_NETWORK", exitCode: ExitCode.NetworkError });
    this.name = "NetworkError";
  }
};
function shortenUrl(url, maxLength = 72) {
  if (url.length <= maxLength) return url;
  try {
    const parsed = new URL(url);
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    if (base.length <= maxLength) return parsed.search === "" ? base : `${base}?\u2026`;
    return `${base.slice(0, maxLength - 1)}\u2026`;
  } catch {
    return `${url.slice(0, maxLength - 1)}\u2026`;
  }
}
var HttpError = class extends NetworkError {
  status;
  constructor(status, url, options = {}) {
    super(`HTTP ${status} for ${shortenUrl(url)}`, {
      ...options,
      code: "E_HTTP",
      details: { status, url, ...options.details }
    });
    this.name = "HttpError";
    this.status = status;
  }
};
var FilesystemError = class extends VectraxError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "E_FS", exitCode: ExitCode.FilesystemError });
    this.name = "FilesystemError";
  }
};
var CancelledError = class extends VectraxError {
  constructor(message = "Cancelled by user.") {
    super(message, { code: "E_CANCELLED", exitCode: ExitCode.Interrupted });
    this.name = "CancelledError";
  }
};
function isVectraxError(value) {
  return value instanceof VectraxError;
}
function isAbortError(value) {
  return value instanceof CancelledError || value instanceof Error && value.name === "AbortError";
}
function isTimeoutError(value) {
  return value instanceof Error && value.name === "TimeoutError";
}
function errorMessage(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function wrapFsError(error, action, target) {
  const code = error?.code;
  const hints = {
    EACCES: "Check the directory permissions, or choose a different output path.",
    EPERM: "Check the directory permissions, or choose a different output path.",
    ENOSPC: "The disk is full. Free up space or pick another volume.",
    EROFS: "The target filesystem is read-only.",
    ENOENT: "A parent directory does not exist.",
    ENOTDIR: "A path component is a file, not a directory.",
    EMFILE: "Too many open files. Lower --concurrency.",
    EXDEV: "Source and destination are on different filesystems."
  };
  return new FilesystemError(`Failed to ${action}: ${target} (${code ?? errorMessage(error)})`, {
    ...code !== void 0 && hints[code] !== void 0 ? { hint: hints[code] } : {},
    details: { errno: code, target },
    cause: error
  });
}

// src/core/scrape/media.ts
var MEDIA_KINDS = ["audio", "video", "image", "archive", "document", "other"];
var EXTENSIONS_BY_KIND = {
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "alac", "aiff", "aif"],
  video: ["mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "wmv", "ts"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  document: ["pdf", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "srt", "vtt"]
};
var KIND_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS_BY_KIND).flatMap(
    ([kind, extensions]) => extensions.map((ext) => [ext, kind])
  )
);
function extensionsForKinds(kinds) {
  const out = /* @__PURE__ */ new Set();
  for (const kind of kinds) {
    if (kind === "other") continue;
    for (const ext of EXTENSIONS_BY_KIND[kind]) out.add(ext);
  }
  return [...out];
}
function kindForExtension(extension) {
  if (extension === void 0) return "other";
  return KIND_BY_EXTENSION.get(extension.replace(/^\./, "").toLowerCase()) ?? "other";
}
var QUALITY_PATTERNS = [
  { pattern: /\b(\d{3,4})\s?kbps\b/i, format: (m) => `${m[1]}kbps` },
  { pattern: /\b(2160|1440|1080|720|480|360)p\b/i, format: (m) => `${m[1]}p` },
  { pattern: /\b(4k|8k)\b/i, format: (m) => m[1].toUpperCase() },
  { pattern: /\b(flac|hi-?res|lossless)\b/i, format: (m) => m[1].toUpperCase() },
  { pattern: /(?:^|[^\d])(320|256|192|128|96|64)(?:[^\d]|$)/, format: (m) => `${m[1]}kbps` }
];
function describeFormat(item) {
  const extension = item.extension?.toUpperCase();
  if (item.quality === void 0) return extension ?? "";
  if (extension === void 0) return item.quality;
  return item.quality.toUpperCase() === extension ? extension : `${item.quality} ${extension}`;
}
function detectQuality(...sources) {
  for (const source of sources) {
    if (source === void 0 || source === "") continue;
    for (const { pattern, format: format2 } of QUALITY_PATTERNS) {
      const match = pattern.exec(source);
      if (match !== null) return format2(match);
    }
  }
  return void 0;
}

// src/core/metadata/types.ts
var EDITABLE_FIELDS = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "genre",
  "year",
  "track",
  "trackTotal",
  "disc",
  "discTotal",
  "composer",
  "comment"
];
var NUMERIC_FIELDS = /* @__PURE__ */ new Set([
  "year",
  "track",
  "trackTotal",
  "disc",
  "discTotal"
]);
var FIELD_LABELS = {
  title: "Title",
  artist: "Artist",
  album: "Album",
  albumArtist: "Album artist",
  genre: "Genre",
  year: "Year",
  track: "Track",
  trackTotal: "Track total",
  disc: "Disc",
  discTotal: "Disc total",
  composer: "Composer",
  comment: "Comment"
};
function isEmptyMetadata(metadata) {
  return !Object.values(metadata).some((value) => value !== void 0 && value !== "");
}
function mergeMetadata(base, updates) {
  const out = { ...base };
  for (const [key, value] of Object.entries(updates)) {
    if (value === void 0) continue;
    if (value === "") delete out[key];
    else Object.assign(out, { [key]: value });
  }
  return out;
}

// src/core/quality.ts
var MAX = "max";
var PRESET_TARGETS = {
  best: { audioKbps: MAX, videoHeight: MAX },
  high: { audioKbps: 320, videoHeight: 1080 },
  balanced: { audioKbps: 256, videoHeight: 720 },
  small: { audioKbps: 128, videoHeight: 480 }
};
var DEFAULT_QUALITY = { preset: "balanced", ...PRESET_TARGETS.balanced };
var PRESET_ALIASES = {
  best: "best",
  max: "best",
  highest: "best",
  lossless: "best",
  high: "high",
  hq: "high",
  balanced: "balanced",
  default: "balanced",
  medium: "balanced",
  small: "small",
  low: "small",
  tiny: "small",
  data: "small"
};
var AUDIO_BITRATE = /^(\d{2,4})\s*k(bps)?$/i;
var VIDEO_HEIGHT = /^(\d{3,4})\s*p$/i;
var SHORTHAND_4K = /^(4k|2160)$/i;
var SHORTHAND_2K = /^(2k|1440)$/i;
function parseQuality(input2) {
  const value = input2.trim().toLowerCase();
  const preset = PRESET_ALIASES[value];
  if (preset !== void 0) return { preset, ...PRESET_TARGETS[preset] };
  if (SHORTHAND_4K.test(value)) return { preset: "best", audioKbps: MAX, videoHeight: 2160 };
  if (SHORTHAND_2K.test(value)) return { preset: "high", audioKbps: MAX, videoHeight: 1440 };
  const audio = AUDIO_BITRATE.exec(value);
  if (audio?.[1] !== void 0) {
    const kbps = Number(audio[1]);
    if (kbps < 8 || kbps > 3e3) {
      throw new UsageError(`Audio bitrate ${kbps}k is outside the usable range (8k\u20133000k).`);
    }
    return { preset: presetForBitrate(kbps), audioKbps: kbps, videoHeight: MAX };
  }
  const video = VIDEO_HEIGHT.exec(value);
  if (video?.[1] !== void 0) {
    const height = Number(video[1]);
    if (height < 144 || height > 4320) {
      throw new UsageError(`Video height ${height}p is outside the usable range (144p\u20134320p).`);
    }
    return { preset: presetForHeight(height), audioKbps: MAX, videoHeight: height };
  }
  throw new UsageError(`Unrecognised quality "${input2}".`, {
    hint: "Use best, high, balanced, small \u2014 or an exact target like 320k or 1080p."
  });
}
function presetForBitrate(kbps) {
  if (kbps >= 320) return "high";
  if (kbps >= 192) return "balanced";
  return "small";
}
function presetForHeight(height) {
  if (height >= 1440) return "best";
  if (height >= 1080) return "high";
  if (height >= 720) return "balanced";
  return "small";
}
function chooseByCeiling(items, valueOf, target, overshoot = 1) {
  if (items.length === 0) return void 0;
  const ranked = [...items].sort((a, b) => valueOf(b) - valueOf(a));
  const bestAvailable = valueOf(ranked[0]);
  if (target === MAX) {
    return { item: ranked[0], value: bestAvailable, target, satisfied: true, bestAvailable };
  }
  const admissible = ranked.filter((item) => valueOf(item) <= target * overshoot);
  if (admissible.length === 0) {
    const smallest = ranked[ranked.length - 1];
    return { item: smallest, value: valueOf(smallest), target, satisfied: false, bestAvailable };
  }
  const distance = (item) => Math.abs(Math.log(Math.max(valueOf(item), 1) / target));
  const nearest = admissible.reduce((best, item) => distance(item) < distance(best) ? item : best);
  return {
    item: nearest,
    value: valueOf(nearest),
    target,
    satisfied: valueOf(nearest) <= target || overshoot > 1,
    bestAvailable
  };
}
function describeShortfall(choice, unit, source) {
  if (choice.target === MAX) return void 0;
  if (!choice.satisfied) {
    return `${source} offers nothing at or below ${choice.target}${unit}; using ${choice.value}${unit}.`;
  }
  if (choice.bestAvailable > choice.target && choice.value < choice.bestAvailable) {
    return void 0;
  }
  if (choice.value < choice.target && choice.bestAvailable <= choice.target) {
    return `${source} tops out at ${choice.bestAvailable}${unit}.`;
  }
  return void 0;
}
var TITLE_KEY = /[^\p{L}\p{N}]+/gu;
function titleKey(title) {
  return title.toLowerCase().replace(/\b\d{2,4}\s*k(bps)?\b/g, "").replace(/\b\d{3,4}\s*p\b/g, "").replace(TITLE_KEY, "").trim();
}
function qualityValue(item) {
  const marker = item.quality;
  if (marker === void 0) return void 0;
  const kbps = /^(\d{2,4})kbps$/i.exec(marker);
  if (kbps?.[1] !== void 0) return Number(kbps[1]);
  const height = /^(\d{3,4})p$/i.exec(marker);
  if (height?.[1] !== void 0) return Number(height[1]);
  if (/^(flac|lossless|hi-?res)$/i.test(marker)) return 1411;
  if (/^4K$/i.test(marker)) return 2160;
  return void 0;
}
function collapseDuplicateQualities(items, targets) {
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = `${titleKey(item.title)}::${item.extension ?? ""}`;
    groups.set(key, [...groups.get(key) ?? [], item]);
  }
  const kept = [];
  let collapsed = 0;
  for (const group of groups.values()) {
    if (group.length === 1 || group.some((item) => qualityValue(item) === void 0)) {
      kept.push(...group);
      continue;
    }
    const isVideo = group.every((item) => (qualityValue(item) ?? 0) >= 144 && /p$/i.test(item.quality ?? ""));
    const target = isVideo ? targets.videoHeight : targets.audioKbps;
    const choice = chooseByCeiling(group, (item) => qualityValue(item) ?? 0, target);
    if (choice === void 0) {
      kept.push(...group);
      continue;
    }
    kept.push(choice.item);
    collapsed += group.length - 1;
  }
  const order = new Map(items.map((item, index) => [item, index]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { kept, collapsed };
}

// src/core/convert/formats.ts
var AUDIO_FORMATS = ["mp3", "m4a", "flac", "wav", "opus", "ogg"];
var VIDEO_FORMATS = ["mp4", "mkv", "webm"];
var KEEP_ORIGINAL = { intent: "original", audio: void 0, video: void 0 };
var ALIASES = {
  mp3: "mp3",
  m4a: "m4a",
  aac: "m4a",
  mp4a: "m4a",
  flac: "flac",
  wav: "wav",
  wave: "wav",
  opus: "opus",
  ogg: "ogg",
  vorbis: "ogg",
  mp4: "mp4",
  m4v: "mp4",
  mkv: "mkv",
  matroska: "mkv",
  webm: "webm"
};
function isAudioFormat(value) {
  return AUDIO_FORMATS.includes(value);
}
function parseFormat(input2) {
  const value = input2.trim().toLowerCase();
  if (value === "original" || value === "source" || value === "keep") return KEEP_ORIGINAL;
  if (value === "compatible" || value === "phone" || value === "universal") {
    return { intent: "compatible", audio: "mp3", video: "mp4" };
  }
  if (value === "archive" || value === "lossless") {
    return { intent: "archive", audio: "flac", video: "mkv" };
  }
  const format2 = ALIASES[value];
  if (format2 === void 0) {
    throw new UsageError(`Unrecognised format "${input2}".`, {
      hint: `Audio: ${AUDIO_FORMATS.join(", ")}. Video: ${VIDEO_FORMATS.join(", ")}. Or use original, compatible, archive.`
    });
  }
  return isAudioFormat(format2) ? { intent: "original", audio: format2, video: void 0 } : { intent: "original", audio: void 0, video: format2 };
}
var LOSSLESS_CODECS = /* @__PURE__ */ new Set(["flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "wavpack"]);
var CONTAINER_CODECS = {
  mp3: ["mp3"],
  m4a: ["aac", "alac", "mp3"],
  flac: ["flac"],
  wav: ["pcm_s16le", "pcm_s24le", "pcm_f32le"],
  opus: ["opus"],
  ogg: ["opus", "vorbis", "flac"],
  mp4: ["aac", "alac", "mp3", "h264", "hevc", "av1", "mpeg4"],
  mkv: ["aac", "alac", "mp3", "flac", "opus", "vorbis", "h264", "hevc", "av1", "vp8", "vp9"],
  webm: ["opus", "vorbis", "vp8", "vp9", "av1"]
};
var ENCODERS = {
  mp3: { audio: "libmp3lame" },
  m4a: { audio: "aac" },
  flac: { audio: "flac" },
  wav: { audio: "pcm_s16le" },
  opus: { audio: "libopus" },
  ogg: { audio: "libopus" },
  mp4: { audio: "aac", video: "libx264" },
  mkv: { audio: "aac", video: "libx264" },
  webm: { audio: "libopus", video: "libvpx-vp9" }
};
function targetFormatFor(choice, probe) {
  const wantsVideo = probe.videoCodec !== void 0;
  return wantsVideo ? choice.video : choice.audio;
}
function codecFits(target, codec) {
  if (codec === void 0) return true;
  return CONTAINER_CODECS[target].includes(codec);
}
function bitrateArgs(probe) {
  if (probe.audioBitrate === void 0) return ["-q:a", "2"];
  const kbps = Math.max(64, Math.min(320, Math.round(probe.audioBitrate / 1e3)));
  return ["-b:a", `${kbps}k`];
}
function planConversion(probe, target) {
  if (probe.extension === target) {
    return { action: "none", target, args: [], warning: void 0 };
  }
  const audioFits = codecFits(target, probe.audioCodec);
  const videoFits = probe.videoCodec === void 0 || codecFits(target, probe.videoCodec);
  if (audioFits && videoFits) {
    return {
      action: "remux",
      target,
      args: ["-c", "copy"],
      warning: void 0
    };
  }
  const encoder2 = ENCODERS[target];
  const args = [];
  let warning;
  if (probe.videoCodec !== void 0) {
    args.push("-c:v", videoFits ? "copy" : encoder2.video ?? "libx264");
    if (!videoFits) warning = `re-encoding video to ${encoder2.video ?? "h264"}, which is slow and loses quality`;
  }
  args.push("-c:a", audioFits ? "copy" : encoder2.audio);
  if (!audioFits) {
    const sourceLossless = probe.audioCodec !== void 0 && LOSSLESS_CODECS.has(probe.audioCodec);
    const targetLossless = target === "flac" || target === "wav";
    if (targetLossless && !sourceLossless) {
      warning = `${probe.audioCodec ?? "the source"} is lossy, so ${target} will be larger without recovering quality`;
    } else if (!targetLossless && !sourceLossless) {
      args.push(...bitrateArgs(probe));
      warning ??= `re-encoding ${probe.audioCodec ?? "audio"} to ${target} loses some quality`;
    }
  }
  if (target === "mp4" || target === "m4a") args.push("-movflags", "+faststart");
  if (target === "m4a" || target === "mp3" || target === "flac" || target === "wav") args.push("-vn");
  return { action: "transcode", target, args, warning };
}

// src/ui/theme.ts
import os from "os";
function windowsBuild() {
  const parts = os.release().split(".");
  return Number(parts[2] ?? 0);
}
function modernWindowsTerminal() {
  const env = process.env;
  return env["WT_SESSION"] !== void 0 || env["WT_PROFILE_ID"] !== void 0 || env["TERM_PROGRAM"] === "vscode" || env["TERM_PROGRAM"] === "Hyper" || env["ConEmuANSI"] === "ON" || env["TERM"] !== void 0;
}
function detectColorLevel(stream = process.stderr) {
  const env = process.env;
  if (env["NO_COLOR"] !== void 0 && env["NO_COLOR"] !== "") return 0;
  if (env["VECTRAX_NO_COLOR"] !== void 0 && env["VECTRAX_NO_COLOR"] !== "") return 0;
  const force = env["FORCE_COLOR"];
  if (force !== void 0) {
    if (force === "0" || force === "false") return 0;
    if (force === "1" || force === "true" || force === "") return 1;
    if (force === "2") return 2;
    if (force === "3") return 3;
  }
  if (env["TERM"] === "dumb") return 0;
  if (!stream.isTTY) return 0;
  const colorterm = env["COLORTERM"];
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (env["TERM_PROGRAM"] === "iTerm.app" || env["TERM_PROGRAM"] === "WezTerm") return 3;
  if (process.platform === "win32") {
    if (modernWindowsTerminal()) return 3;
    const build = windowsBuild();
    if (build >= 14931) return 3;
    if (build >= 10586) return 2;
    return 1;
  }
  if (env["TERM"]?.includes("256")) return 2;
  if (env["CI"] !== void 0) return 1;
  return 1;
}
var colorLevel = detectColorLevel();
var unicodeSupported = process.env["VECTRAX_ASCII"] === void 0 && (process.platform !== "win32" || modernWindowsTerminal() || windowsBuild() >= 22e3);
var hex = (value) => {
  const n = Number.parseInt(value.replace("#", ""), 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
};
var PALETTE = {
  violet: { rgb: hex("#A855F7"), ansi256: 141, fallback: 35 },
  violetBright: { rgb: hex("#C4A5FF"), ansi256: 183, fallback: 95 },
  violetDeep: { rgb: hex("#7C3AED"), ansi256: 99, fallback: 35 },
  white: { rgb: hex("#F8FAFC"), ansi256: 255, fallback: 97 },
  muted: { rgb: hex("#8B8FA3"), ansi256: 245, fallback: 90 },
  success: { rgb: hex("#4ADE80"), ansi256: 114, fallback: 32 },
  warn: { rgb: hex("#FBBF24"), ansi256: 221, fallback: 33 },
  danger: { rgb: hex("#F87171"), ansi256: 210, fallback: 31 },
  info: { rgb: hex("#67E8F9"), ansi256: 117, fallback: 36 }
};
var RESET = "\x1B[0m";
function fgCode(key) {
  const entry = PALETTE[key];
  switch (colorLevel) {
    case 3:
      return `\x1B[38;2;${entry.rgb.r};${entry.rgb.g};${entry.rgb.b}m`;
    case 2:
      return `\x1B[38;5;${entry.ansi256}m`;
    case 1:
      return `\x1B[${entry.fallback}m`;
    default:
      return "";
  }
}
function bgCode(key) {
  const entry = PALETTE[key];
  switch (colorLevel) {
    case 3:
      return `\x1B[48;2;${entry.rgb.r};${entry.rgb.g};${entry.rgb.b}m`;
    case 2:
      return `\x1B[48;5;${entry.ansi256}m`;
    case 1:
      return `\x1B[${entry.fallback + 10}m`;
    default:
      return "";
  }
}
function makePainter(open) {
  if (open === "") return (text2) => text2;
  return (text2) => `${open}${text2}${RESET}`;
}
function makeStyle(code) {
  if (colorLevel === 0) return (text2) => text2;
  return (text2) => `\x1B[${code}m${text2}\x1B[0m`;
}
var c = {
  accent: makePainter(fgCode("violet")),
  accentBright: makePainter(fgCode("violetBright")),
  accentDeep: makePainter(fgCode("violetDeep")),
  text: makePainter(fgCode("white")),
  muted: makePainter(fgCode("muted")),
  success: makePainter(fgCode("success")),
  warn: makePainter(fgCode("warn")),
  danger: makePainter(fgCode("danger")),
  info: makePainter(fgCode("info")),
  onAccent: makePainter(`${bgCode("violetDeep")}${fgCode("white")}`),
  onDanger: makePainter(`${bgCode("danger")}${fgCode("white")}`),
  bold: makeStyle(1),
  dim: makeStyle(2),
  italic: makeStyle(3),
  underline: makeStyle(4),
  inverse: makeStyle(7)
};
function gradient(from, to, steps) {
  const a = hex(from);
  const b = hex(to);
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    if (colorLevel === 3) out.push(makePainter(`\x1B[38;2;${r};${g};${bl}m`));
    else if (colorLevel === 2) out.push(makePainter(fgCode(t < 0.5 ? "white" : "violet")));
    else if (colorLevel === 1) out.push(makePainter(fgCode(t < 0.5 ? "white" : "violet")));
    else out.push((text2) => text2);
  }
  return out;
}
var glyph = unicodeSupported ? {
  tick: "\u2714",
  cross: "\u2716",
  warn: "\u25B2",
  info: "\u203A",
  bullet: "\u22C4",
  arrow: "\u2192",
  pointer: "\u27E9",
  barFull: "\u25B0",
  barPartial: ["", "\u25B1", "\u25AA", "\u25AB"],
  barEmpty: "\xB7",
  lineV: "\u2502",
  cornerTop: "\u256D",
  cornerBottom: "\u2570",
  radioOn: "\u25C9",
  radioOff: "\u25EF",
  checkOn: "\u25C6",
  checkOff: "\u25C7",
  spinner: ["\u2B21", "\u2B22", "\u2B23", "\u2B22"],
  ellipsis: "\u2026"
} : {
  tick: "+",
  cross: "x",
  warn: "!",
  info: ">",
  bullet: "*",
  arrow: "->",
  pointer: ">",
  barFull: "#",
  barPartial: [""],
  barEmpty: ".",
  lineV: "|",
  cornerTop: "+",
  cornerBottom: "+",
  radioOn: "(*)",
  radioOff: "( )",
  checkOn: "[x]",
  checkOff: "[ ]",
  spinner: ["-", "\\", "|", "/"],
  ellipsis: "..."
};
var ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
function stripAnsi(text2) {
  return text2.replace(ANSI_PATTERN, "");
}
var ansi = {
  reset: RESET,
  hideCursor: "\x1B[?25l",
  showCursor: "\x1B[?25h",
  clearLine: "\x1B[2K",
  cursorHome: "\x1B[G",
  cursorUp: (n) => n > 0 ? `\x1B[${n}A` : "",
  cursorDown: (n) => n > 0 ? `\x1B[${n}B` : ""
};

// src/ui/chemistry.ts
var reagents = unicodeSupported ? {
  vapour: ["\xB7", "\u02D9", "\u2218", "\xB0", "\u2058", "\u2059"],
  residue: ["\u2591", "\u2592", "\u2593"],
  bond: ["\u2500", "\u2550", "\u254C", "\u2504"],
  nucleus: ["\u25CC", "\u25CD", "\u25CE", "\u25CF", "\u25C9", "\u2B24"],
  drift: ["\u22C5", "\u2219", "\u2022", "\u2218", "\u25CB"],
  unstable: ["#", "%", "&", "@", "\xA7", "\xA4", "\xD7", "\u2260", "\u2206", "\u2207", "\u2248", "\u2234", "\u2301", "\u2307"],
  flask: "\u29D7",
  atom: "\u232C",
  spark: "\u2726"
} : {
  vapour: [".", "'", "`", '"'],
  residue: [".", ":", "#"],
  bond: ["-", "=", "~"],
  nucleus: [".", "o", "O", "0", "@"],
  drift: [".", ":", "*", "o"],
  unstable: ["#", "%", "&", "@", "$", "*", "x", "?", "!", "/"],
  flask: "Y",
  atom: "*",
  spark: "+"
};
var entropy = 2654435769;
function nextRandom() {
  entropy ^= entropy << 13;
  entropy ^= entropy >>> 17;
  entropy ^= entropy << 5;
  return (entropy >>> 0) % 1e5 / 1e5;
}
function seedEntropy(seed) {
  entropy = seed === 0 ? 2654435769 : seed >>> 0;
}
function condense(text2, progress) {
  if (progress >= 1) return text2;
  const settled = Math.max(0, Math.min(1, progress));
  const vapour = reagents.vapour;
  return [...text2].map((char) => {
    if (char === " ") return char;
    if (nextRandom() <= settled) return char;
    return vapour[Math.floor(nextRandom() * vapour.length)] ?? char;
  }).join("");
}
function reactionEdge(phase) {
  const frames = reagents.residue;
  return frames[phase % frames.length] ?? "";
}

// src/core/util/format.ts
import stringWidth from "string-width";
var BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
function formatBytes(bytes, fractionDigits) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = fractionDigits ?? (exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}
function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "\u2014";
  return `${formatBytes(bytesPerSecond)}/s`;
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  const totalSeconds = Math.round(ms / 1e3);
  if (totalSeconds < 60) return ms < 1e4 ? `${(ms / 1e3).toFixed(1)}s` : `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function formatEta(ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return "--:--";
  const totalSeconds = Math.min(Math.round(ms / 1e3), 99 * 3600);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return "  0%";
  return `${String(Math.min(100, Math.max(0, Math.round(ratio * 100)))).padStart(3, " ")}%`;
}
var displayWidth = (text2) => stringWidth(text2);
function truncate(text2, maxWidth, ellipsis = "\u2026") {
  if (maxWidth <= 0) return "";
  if (displayWidth(text2) <= maxWidth) return text2;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let width = 0;
  let out = "";
  for (const char of text2) {
    const charWidth = displayWidth(char);
    if (width + charWidth > budget) break;
    width += charWidth;
    out += char;
  }
  return out + ellipsis;
}
function padEnd(text2, width) {
  const delta = width - displayWidth(text2);
  return delta > 0 ? text2 + " ".repeat(delta) : text2;
}
function padStart(text2, width) {
  const delta = width - displayWidth(text2);
  return delta > 0 ? " ".repeat(delta) + text2 : text2;
}
function renderBar(ratio, width, glyphs) {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const exact = clamped * width;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const partialIndex = Math.floor(remainder * glyphs.partial.length);
  const partial = full < width ? glyphs.partial[partialIndex] ?? "" : "";
  const filled = glyphs.full.repeat(full) + partial;
  const emptyCount = Math.max(0, width - full - displayWidth(partial));
  return filled + glyphs.empty.repeat(emptyCount);
}
function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// src/ui/layout.ts
var MICRO_MAX = 44;
var COMPACT_MAX = 72;
var NORMAL_MAX = 108;
function breakpointFor(columns) {
  if (columns <= MICRO_MAX) return "micro";
  if (columns <= COMPACT_MAX) return "compact";
  if (columns <= NORMAL_MAX) return "normal";
  return "wide";
}
function usableColumns(stream) {
  const columns = stream.columns;
  return columns !== void 0 && columns > 0 ? columns : 80;
}
function usableRows(stream) {
  const rows = stream.rows;
  return rows !== void 0 && rows > 0 ? rows : 24;
}
function wrap(text2, width) {
  if (width <= 0) return [text2];
  const lines = [];
  for (const paragraph of text2.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (displayWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current !== "") lines.push(current);
      current = displayWidth(word) > width ? truncate(word, width) : word;
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}
function planColumns(columns) {
  switch (breakpointFor(columns)) {
    case "micro":
      return { title: Math.max(8, columns - 12), bar: 0, showStats: false, showRate: false, showEta: false };
    case "compact":
      return { title: Math.max(10, columns - 26), bar: 10, showStats: false, showRate: false, showEta: false };
    case "normal":
      return { title: Math.max(14, columns - 52), bar: 16, showStats: true, showRate: false, showEta: false };
    default:
      return { title: Math.max(20, columns - 70), bar: 22, showStats: true, showRate: true, showEta: true };
  }
}
function fit(text2, width) {
  const clipped = truncate(text2, width);
  const pad = width - displayWidth(clipped);
  return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

// src/ui/banner.ts
var WORDMARK = [
  "\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557  \u2588\u2588\u2557",
  "\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u255A\u2588\u2588\u2557\u2588\u2588\u2554\u255D",
  "\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551        \u2588\u2588\u2551   \u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2554\u255D ",
  "\u255A\u2588\u2588\u2557 \u2588\u2588\u2554\u255D\u2588\u2588\u2554\u2550\u2550\u255D  \u2588\u2588\u2551        \u2588\u2588\u2551   \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551 \u2588\u2588\u2554\u2588\u2588\u2557 ",
  " \u255A\u2588\u2588\u2588\u2588\u2554\u255D \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557   \u2588\u2588\u2551   \u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2554\u255D \u2588\u2588\u2557",
  "  \u255A\u2550\u2550\u2550\u255D  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D   \u255A\u2550\u255D   \u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D"
];
var WORDMARK_WIDTH = Math.max(...WORDMARK.map(displayWidth));
var LATTICE = unicodeSupported ? "\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C\u2500\u2500\u2500\u232C" : "*---*---*---*---*---*---*---*---*---*---*---*---*---*---*";
var TAGLINE = "volatile media extraction";
function renderBanner(options) {
  const detected = options.columns ?? usableColumns(process.stdout);
  const columns = detected > 0 ? detected : 80;
  const tagline = options.tagline ?? TAGLINE;
  const settle = options.settle ?? 1;
  if (columns < WORDMARK_WIDTH + 4) return renderCompactBanner(options.version, tagline, columns);
  const shades = gradient("#FFFFFF", "#7C3AED", WORDMARK.length);
  const indent = "  ";
  const lines = WORDMARK.map((line, index) => {
    const paint = shades[index] ?? ((text2) => text2);
    const settled = settle >= 1 ? line : condense(line, settle);
    return indent + paint(settled);
  });
  const latticeWidth = Math.min(WORDMARK_WIDTH, columns - indent.length * 2);
  const lattice = indent + c.accentDeep(LATTICE.slice(0, latticeWidth));
  const meta = [
    c.accent(`v${options.version}`),
    c.muted(reagents.bond[0] ?? "-"),
    c.muted(tagline)
  ].join(" ");
  return ["", ...lines, lattice, `${indent}${meta}`, ""].join("\n");
}
function renderCompactBanner(version, tagline, columns) {
  const mark = colorLevel > 0 ? c.onAccent(` ${reagents.atom} VECTRAX `) : `[ VECTRAX ]`;
  const head = `  ${mark} ${c.accent(`v${version}`)}`;
  const room = columns - displayWidth(`  [ ${reagents.atom} VECTRAX ] v${version}  `);
  const suffix = room >= displayWidth(tagline) ? `  ${c.muted(tagline)}` : "";
  return `
${head}${suffix}
`;
}
function shouldShowBanner(options) {
  if (options.json || options.quiet || options.noBanner) return false;
  if (process.env["VECTRAX_NO_BANNER"] !== void 0) return false;
  return (options.stream ?? process.stderr).isTTY === true;
}
var REACTION_STEPS = 7;
var REACTION_FRAME_MS = 42;
async function playBannerReaction(options) {
  const stream = options.stream ?? process.stderr;
  const columns = usableColumns(stream);
  if (breakpointFor(columns) === "micro" || process.env["VECTRAX_NO_ANIMATION"] !== void 0) {
    stream.write(`${renderBanner({ ...options, columns })}
`);
    return;
  }
  seedEntropy(6221086);
  const settled = renderBanner({ ...options, columns });
  const height = settled.split("\n").length;
  stream.write("\x1B[?25l");
  try {
    for (let step = 0; step < REACTION_STEPS; step++) {
      stream.write(renderBanner({ ...options, columns, settle: (step + 1) / REACTION_STEPS }));
      await sleep(REACTION_FRAME_MS);
      stream.write(`\x1B[${height - 1}A\x1B[G`);
    }
  } finally {
    stream.write(`${settled}
\x1B[?25h`);
  }
}
function sleep(ms) {
  return new Promise((resolve2) => {
    setTimeout(resolve2, ms);
  });
}

// src/version.ts
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
function readVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (manifest.name === "vectrax" && manifest.version !== void 0) return manifest.version;
    } catch {
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
var VERSION = readVersion();

// src/core/http/client.ts
import { setTimeout as sleep2 } from "timers/promises";

// src/core/http/guard.ts
import { isIP } from "net";
var ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function parseUrl(input2, options = {}) {
  const trimmed = input2.trim();
  if (trimmed === "") {
    throw new VectraxError("No URL provided.", {
      code: "E_URL_INVALID",
      exitCode: ExitCode.UsageError,
      hint: 'Pass a page or file URL, e.g. vectrax get "https://example.com/album".'
    });
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new VectraxError(`Not a valid URL: ${input2}`, {
      code: "E_URL_INVALID",
      exitCode: ExitCode.UsageError,
      hint: "Include the scheme, e.g. https://example.com/page."
    });
  }
  assertUrlAllowed(url, options);
  return url;
}
function assertUrlAllowed(url, options = {}) {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new VectraxError(`Unsupported URL scheme "${url.protocol}".`, {
      code: "E_URL_BLOCKED",
      exitCode: ExitCode.UsageError,
      hint: "Vectrax only fetches http:// and https:// URLs.",
      details: { url: url.href }
    });
  }
  if (url.protocol === "http:" && options.allowInsecure === false) {
    throw new VectraxError(`Refusing plaintext HTTP request to ${url.host}.`, {
      code: "E_URL_BLOCKED",
      exitCode: ExitCode.UsageError,
      hint: "Pass --insecure to allow http:// URLs.",
      details: { url: url.href }
    });
  }
  if (options.allowPrivateHosts !== true && isPrivateHost(url.hostname)) {
    throw new VectraxError(`Refusing to connect to private address "${url.hostname}".`, {
      code: "E_URL_BLOCKED",
      exitCode: ExitCode.UsageError,
      hint: "Pass --allow-private if you intend to reach a host on your own network.",
      details: { url: url.href }
    });
  }
}
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "" || host === "0.0.0.0") return true;
  const version = isIP(host);
  if (version === 4) {
    const parts = host.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fe80")) return true;
    if (/^f[cd]/.test(host)) return true;
    const mapped = /^::ffff:(.+)$/.exec(host);
    if (mapped?.[1] !== void 0 && isIP(mapped[1]) === 4) return isPrivateHost(mapped[1]);
    return false;
  }
  return false;
}
function normalizeUrl(url) {
  const clone = new URL(url.href);
  clone.hash = "";
  clone.searchParams.sort();
  if (clone.protocol === "https:" && clone.port === "443" || clone.protocol === "http:" && clone.port === "80") {
    clone.port = "";
  }
  return clone.href;
}
function isCrossOrigin(from, to) {
  return from.protocol !== to.protocol || from.host !== to.host;
}

// src/core/http/client.ts
var DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
var HttpClient = class {
  userAgent;
  baseHeaders;
  timeoutMs;
  retries;
  retryDelayMs;
  maxRedirects;
  guard;
  onRetry;
  constructor(options = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.baseHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 3e4;
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 600;
    this.maxRedirects = options.maxRedirects ?? 8;
    this.guard = options.guard ?? {};
    this.onRetry = options.onRetry;
  }
  async request(target, options = {}) {
    const maxAttempts = (options.retries ?? this.retries) + 1;
    let lastError2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.requestOnce(target, options);
        const retryable = RETRYABLE_STATUS.has(result.response.status) || options.retryStatuses?.includes(result.response.status) === true;
        if (attempt < maxAttempts && retryable) {
          await result.response.body?.cancel().catch(() => void 0);
          const delayMs = this.backoff(attempt, result.response.headers.get("retry-after"));
          this.onRetry?.({
            url: String(target),
            attempt,
            maxAttempts,
            delayMs,
            reason: `HTTP ${result.response.status}`
          });
          await sleep2(delayMs, void 0, { signal: options.signal });
          continue;
        }
        return result;
      } catch (error) {
        if (isAbortError(error) || error instanceof VectraxError) throw error;
        lastError2 = error;
        if (attempt >= maxAttempts) break;
        const delayMs = this.backoff(attempt, null);
        this.onRetry?.({
          url: String(target),
          attempt,
          maxAttempts,
          delayMs,
          reason: errorMessage(error)
        });
        await sleep2(delayMs, void 0, { signal: options.signal });
      }
    }
    const timedOut = isTimeoutError(lastError2);
    throw new NetworkError(
      timedOut ? `Timed out waiting for ${shortenUrl(String(target))} to respond.` : `Request failed: ${errorMessage(lastError2)}`,
      {
        code: timedOut ? "E_TIMEOUT" : "E_NETWORK",
        hint: timedOut ? "The server did not send response headers in time. Raise --timeout if the host is simply slow." : "Check your connection, or increase --timeout / --retries.",
        details: { url: String(target) },
        cause: lastError2
      }
    );
  }
  backoff(attempt, retryAfter) {
    return computeBackoff(attempt, this.retryDelayMs, retryAfter);
  }
  async requestOnce(target, options) {
    let url = target instanceof URL ? new URL(target.href) : new URL(target);
    let referer = options.referer;
    let method = options.method ?? "GET";
    let body = options.body;
    const origin = new URL(url.href);
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      assertUrlAllowed(url, this.guard);
      const headers = new Headers({
        "user-agent": this.userAgent,
        "accept-language": "en;q=0.9,*;q=0.5",
        ...this.baseHeaders,
        ...options.headers
      });
      if (referer !== void 0 && referer !== "") headers.set("referer", referer);
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const headerTimeout = new AbortController();
      const timer = setTimeout(
        () => headerTimeout.abort(new DOMException("Timed out waiting for response headers", "TimeoutError")),
        timeoutMs
      );
      const signals = [headerTimeout.signal];
      if (options.signal !== void 0) signals.push(options.signal);
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          redirect: "manual",
          signal: AbortSignal.any(signals),
          ...body !== void 0 && method === "POST" ? { body } : {}
        });
      } finally {
        clearTimeout(timer);
      }
      if (!isRedirect(response.status)) {
        return { response, url };
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => void 0);
      if (location === null || location === "") {
        throw new HttpError(response.status, url.href, {
          hint: "The server sent a redirect without a Location header."
        });
      }
      const next = new URL(location, url);
      if (url.protocol === "https:" && next.protocol === "http:") {
        throw new VectraxError(`Refusing insecure redirect from ${url.host} to ${next.href}`, {
          code: "E_URL_BLOCKED",
          hint: "The server tried to downgrade the connection to plaintext HTTP."
        });
      }
      if (isCrossOrigin(origin, next)) referer = void 0;
      if (method === "POST" && response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = void 0;
      }
      url = next;
    }
    throw new NetworkError(`Too many redirects (>${this.maxRedirects}) starting at ${String(target)}`, {
      hint: "The server is redirecting in a loop."
    });
  }
  async requestOk(target, options = {}) {
    const result = await this.request(target, options);
    if (!result.response.ok) {
      await result.response.body?.cancel().catch(() => void 0);
      throw new HttpError(result.response.status, result.url.href, {
        hint: httpStatusHint(result.response.status)
      });
    }
    return result;
  }
  async text(target, options = {}) {
    const { response, url } = await this.requestOk(target, {
      ...options,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...options.headers
      }
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { body: decodeBody(buffer, response.headers.get("content-type")), url };
  }
  async json(target, options = {}) {
    const { response, url } = await this.requestOk(target, {
      ...options,
      headers: { accept: "application/json", ...options.headers }
    });
    const text2 = await response.text();
    try {
      return JSON.parse(text2);
    } catch (error) {
      throw new NetworkError(`Expected JSON from ${url.host} but got something else.`, {
        hint: "The service may be rate-limiting or returning an error page.",
        details: { url: url.href, preview: text2.slice(0, 120) },
        cause: error
      });
    }
  }
  async buffer(target, options = {}) {
    const { response, url } = await this.requestOk(target, options);
    const declared = Number(response.headers.get("content-length"));
    const total = Number.isFinite(declared) && declared > 0 ? declared : void 0;
    const limit = options.maxBytes ?? 32 * 1024 * 1024;
    if (total !== void 0 && total > limit) {
      await response.body?.cancel().catch(() => void 0);
      throw new NetworkError(`Refusing to buffer ${total} bytes from ${url.host} (limit ${limit}).`);
    }
    if (options.onProgress === void 0 || response.body === null) {
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > limit) {
        throw new NetworkError(`Response from ${url.host} exceeded the ${limit}-byte buffer limit.`);
      }
      return { data, contentType: response.headers.get("content-type") };
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > limit) {
        throw new NetworkError(`Response from ${url.host} exceeded the ${limit}-byte buffer limit.`);
      }
      chunks.push(Buffer.from(chunk));
      options.onProgress(received, total);
    }
    return { data: Buffer.concat(chunks), contentType: response.headers.get("content-type") };
  }
  async probe(target, options = {}) {
    try {
      const head = await this.request(target, { ...options, method: "HEAD", retries: 0 });
      await head.response.body?.cancel().catch(() => void 0);
      if (head.response.ok) return readProbe(head.response, head.url);
    } catch {
    }
    const probe = await this.request(target, {
      ...options,
      method: "GET",
      headers: { ...options.headers, range: "bytes=0-0" },
      retries: 0
    });
    await probe.response.body?.cancel().catch(() => void 0);
    if (!probe.response.ok) {
      throw new HttpError(probe.response.status, probe.url.href, {
        hint: httpStatusHint(probe.response.status)
      });
    }
    return readProbe(probe.response, probe.url);
  }
};
function readProbe(response, url) {
  const headers = response.headers;
  const contentRange = headers.get("content-range");
  const totalFromRange = contentRange !== null ? Number(contentRange.split("/")[1]) : Number.NaN;
  const contentLength = Number(headers.get("content-length"));
  const size = Number.isFinite(totalFromRange) ? totalFromRange : response.status !== 206 && Number.isFinite(contentLength) && contentLength > 0 ? contentLength : void 0;
  return {
    url,
    size,
    contentType: headers.get("content-type"),
    contentDisposition: headers.get("content-disposition"),
    etag: headers.get("etag"),
    lastModified: headers.get("last-modified"),
    supportsRanges: response.status === 206 || headers.get("accept-ranges")?.includes("bytes") === true
  };
}
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function computeBackoff(attempt, baseMs, retryAfter) {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, 3e4);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 3e4);
  }
  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), 15e3);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}
function httpStatusHint(status) {
  if (status === 401 || status === 403) {
    return "The server rejected the request. It may require a session cookie or a specific Referer (--referer).";
  }
  if (status === 404) return "The resource no longer exists at that URL.";
  if (status === 429) return "Rate limited. Lower --concurrency or retry later.";
  if (status >= 500) return "The server is failing. Try again shortly.";
  return void 0;
}
function decodeBody(buffer, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const head = buffer.subarray(0, 4096).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  for (const charset of [fromHeader, fromMeta, "utf-8"]) {
    if (charset === void 0) continue;
    try {
      return new TextDecoder(charset, { fatal: false }).decode(buffer);
    } catch {
    }
  }
  return buffer.toString("utf8");
}

// src/ui/logger.ts
var LEVEL_RANK = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
var Logger = class {
  level;
  json;
  stdout;
  stderr;
  constructor(options = {}) {
    this.level = options.level ?? "info";
    this.json = options.json ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }
  get isInteractive() {
    return this.stderr.isTTY === true && !this.json && this.level !== "silent";
  }
  get columns() {
    const stdout = this.stdout.columns;
    return stdout !== void 0 && stdout > 0 ? stdout : usableColumns(this.stderr);
  }
  enabled(level) {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[level];
  }
  emit(level, label, message, fields) {
    if (!this.enabled(level)) return;
    if (this.json) {
      this.stderr.write(`${JSON.stringify({ level, message, ...fields })}
`);
      return;
    }
    this.stderr.write(`${label} ${message}
`);
  }
  info(message, fields) {
    this.emit("info", c.accent(glyph.info), c.text(message), fields);
  }
  step(message, fields) {
    this.emit("info", c.accentDeep(glyph.pointer), c.text(message), fields);
  }
  success(message, fields) {
    this.emit("info", c.success(glyph.tick), c.text(message), fields);
  }
  warn(message, fields) {
    this.emit("warn", c.warn(glyph.warn), c.text(message), fields);
  }
  error(message, fields) {
    this.emit("error", c.danger(glyph.cross), c.text(message), fields);
  }
  debug(message, fields) {
    this.emit("debug", c.muted(glyph.bullet), c.muted(message), fields);
  }
  detail(message) {
    if (!this.enabled("info") || this.json) return;
    for (const line of wrap(message, Math.max(20, this.columns - 2))) {
      this.stderr.write(`  ${c.muted(line)}
`);
    }
  }
  blank() {
    if (!this.enabled("info") || this.json) return;
    this.stderr.write("\n");
  }
  field(label, value) {
    if (!this.enabled("info") || this.json) return;
    const gutter = 14;
    const [first, ...rest] = wrap(value, Math.max(16, this.columns - gutter));
    this.stderr.write(`  ${c.muted(label.padEnd(11))} ${c.text(first ?? "")}
`);
    for (const line of rest) this.stderr.write(`${" ".repeat(gutter)}${c.text(line)}
`);
  }
  heading(title) {
    if (!this.enabled("info") || this.json) return;
    this.stderr.write(`
${c.accent(glyph.lineV)} ${c.bold(c.text(title.toUpperCase()))}
`);
  }
  result(text2) {
    this.stdout.write(`${this.stdout.isTTY === true ? text2 : stripAnsi(text2)}
`);
  }
  resultJson(value) {
    this.stdout.write(`${JSON.stringify(value, null, 2)}
`);
  }
};

// src/config/store.ts
import { readFile, writeFile } from "fs/promises";
import path4 from "path";
import "zod";

// src/core/util/fs.ts
import { constants } from "fs";
import { access, mkdir, rename, copyFile, unlink, stat } from "fs/promises";
import path2 from "path";
import os2 from "os";
function resolvePath(input2) {
  const trimmed = stripSurroundingQuotes(input2.trim());
  const expanded = trimmed === "~" || trimmed.startsWith(`~${path2.sep}`) || trimmed.startsWith("~/") ? path2.join(os2.homedir(), trimmed.slice(1)) : trimmed;
  return path2.resolve(expanded);
}
function stripSurroundingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") return value.slice(1, -1);
  }
  return value;
}
async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    throw wrapFsError(error, "create directory", dir);
  }
}
async function ensureWritableDir(dir) {
  await ensureDir(dir);
  try {
    await access(dir, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new FilesystemError(`Directory is not writable: ${dir}`, {
      hint: "Pick a different --output directory or fix its permissions.",
      cause: error
    });
  }
  return dir;
}
async function pathExists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function fileSize(target) {
  try {
    const info = await stat(target);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}
async function removeQuietly(target) {
  try {
    await unlink(target);
  } catch {
  }
}
async function moveFile(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    const code = error.code;
    if (code !== "EXDEV") throw wrapFsError(error, "move file", from);
  }
  try {
    await copyFile(from, to);
    await unlink(from);
  } catch (error) {
    throw wrapFsError(error, "move file across devices", from);
  }
}
async function uniquePath(dir, filename, maxAttempts = 1e3) {
  const ext = path2.extname(filename);
  const base = path2.basename(filename, ext);
  let candidate = path2.join(dir, filename);
  for (let n = 2; n <= maxAttempts; n++) {
    if (!await pathExists(candidate)) return candidate;
    candidate = path2.join(dir, `${base} (${n})${ext}`);
  }
  throw new FilesystemError(`Could not find a free filename for "${filename}" in ${dir}`, {
    hint: "Clear out the directory or use --overwrite."
  });
}

// src/core/util/platform.ts
import { access as access2, constants as constants2 } from "fs/promises";
import os3 from "os";
import path3 from "path";
function platform() {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}
var isWindows = () => process.platform === "win32";
function executableExtensions() {
  if (!isWindows()) return [""];
  const pathext = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathext.split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean)];
}
async function findExecutable(name) {
  const entries = (process.env["PATH"] ?? "").split(path3.delimiter).filter(Boolean);
  const extensions = executableExtensions();
  const hasExtension = path3.extname(name) !== "";
  for (const entry of entries) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path3.join(entry, `${name}${extension}`);
      try {
        await access2(candidate, isWindows() ? constants2.F_OK : constants2.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  return void 0;
}
function windowsAppData(kind) {
  const value = kind === "local" ? process.env["LOCALAPPDATA"] : process.env["APPDATA"];
  return value !== void 0 && value !== "" ? value : void 0;
}
function configDirectory() {
  const override = process.env["VECTRAX_CONFIG_DIR"];
  if (override !== void 0 && override !== "") return path3.resolve(override);
  if (isWindows()) {
    const base = windowsAppData("roaming") ?? path3.join(os3.homedir(), "AppData", "Roaming");
    return path3.join(base, "Vectrax");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== void 0 && xdg !== "") return path3.join(xdg, "vectrax");
  if (platform() === "macos") {
    return path3.join(os3.homedir(), "Library", "Application Support", "Vectrax");
  }
  return path3.join(os3.homedir(), ".config", "vectrax");
}
function dataDirectory() {
  const override = process.env["VECTRAX_DATA_DIR"];
  if (override !== void 0 && override !== "") return path3.resolve(override);
  if (isWindows()) {
    const base = windowsAppData("local") ?? path3.join(os3.homedir(), "AppData", "Local");
    return path3.join(base, "Vectrax");
  }
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg !== void 0 && xdg !== "") return path3.join(xdg, "vectrax");
  if (platform() === "macos") {
    return path3.join(os3.homedir(), "Library", "Application Support", "Vectrax");
  }
  return path3.join(os3.homedir(), ".local", "share", "vectrax");
}
function toolsDirectory() {
  return path3.join(dataDirectory(), "tools");
}
function defaultDownloadDirectory() {
  return path3.join(os3.homedir(), "Downloads", "Vectrax");
}
function architecture() {
  return process.arch;
}

// src/config/schema.ts
import { z } from "zod";
var DEFAULT_OUTPUT_DIR = defaultDownloadDirectory();
var configSchema = z.object({
  outputDir: z.string().min(1).default(DEFAULT_OUTPUT_DIR),
  concurrency: z.coerce.number().int().min(1).max(16).default(4),
  retries: z.coerce.number().int().min(0).max(10).default(3),
  timeoutMs: z.coerce.number().int().min(1e3).max(6e5).default(3e4),
  stallTimeoutMs: z.coerce.number().int().min(5e3).max(6e5).default(6e4),
  userAgent: z.string().min(1).default(DEFAULT_USER_AGENT),
  referer: z.string().default("auto"),
  kinds: z.array(z.enum(MEDIA_KINDS)).min(1).default(["audio"]),
  conflict: z.enum(["rename", "skip", "overwrite"]).default("rename"),
  resume: z.boolean().default(true),
  allowPrivateHosts: z.boolean().default(false),
  allowInsecure: z.boolean().default(true),
  fallback: z.boolean().default(true)
});
var CONFIG_KEYS = Object.keys(configSchema.shape);
function envNameFor(key) {
  return `VECTRAX_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}
function configFromEnv(env = process.env) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    const raw = env[envNameFor(key)];
    if (raw === void 0 || raw === "") continue;
    if (key === "kinds") out[key] = raw.split(",").map((value) => value.trim()).filter(Boolean);
    else if (key === "resume" || key === "allowPrivateHosts" || key === "allowInsecure") {
      out[key] = raw !== "0" && raw.toLowerCase() !== "false";
    } else out[key] = raw;
  }
  return out;
}

// src/config/store.ts
function configFilePath() {
  return path4.join(configDirectory(), "config.json");
}
async function readConfigFile(file = configFilePath()) {
  if (!await pathExists(file)) return {};
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config file: ${file}`, { cause: error });
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new ConfigError(`Config file is not valid JSON: ${file}`, {
      hint: "Fix the syntax, or delete the file to start from defaults.",
      cause: error
    });
  }
}
async function writeConfigFile(values, file = configFilePath()) {
  await ensureDir(path4.dirname(file));
  await writeFile(file, `${JSON.stringify(values, null, 2)}
`, "utf8");
}
async function resolveConfig(options = {}) {
  const fileValues = await readConfigFile(options.file ?? configFilePath());
  const merged = {
    ...compact(fileValues),
    ...compact(configFromEnv(options.env)),
    ...compact(options.overrides ?? {})
  };
  return parseConfig(merged);
}
function parseConfig(values) {
  const result = configSchema.safeParse(values);
  if (result.success) return result.data;
  throw new ConfigError(`Invalid configuration:
${formatIssues(result.error)}`, {
    hint: "Run `vectrax config list` to see the current values."
  });
}
function parseConfigValue(key, value) {
  const shape = configSchema.shape;
  const field = shape[key];
  if (field === void 0) {
    throw new ConfigError(`Unknown config key "${key}".`, {
      hint: "Run `vectrax config list` to see available keys."
    });
  }
  let candidate = value;
  if (key === "kinds") candidate = value.split(",").map((v) => v.trim()).filter(Boolean);
  else if (key === "resume" || key === "allowPrivateHosts" || key === "allowInsecure") {
    candidate = value !== "0" && value.toLowerCase() !== "false";
  }
  const result = field.safeParse(candidate);
  if (!result.success) {
    throw new ConfigError(`Invalid value for "${key}": ${formatIssues(result.error)}`);
  }
  return result.data;
}
function formatIssues(error) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field === "" ? issue.message : `  ${field}: ${issue.message}`;
  }).join("\n");
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
}

// src/cli/context.ts
function levelFor(flags) {
  if (flags.quiet === true) return "error";
  if (flags.verbose === true) return "debug";
  return "info";
}
async function createContext(options) {
  const logger = new Logger({
    level: levelFor(options.flags),
    json: options.flags.json ?? false
  });
  const config = await resolveConfig({
    ...options.overrides !== void 0 ? { overrides: options.overrides } : {},
    ...options.flags.config !== void 0 ? { file: options.flags.config } : {},
    ...options.file !== void 0 ? { file: options.file } : {}
  });
  const http = new HttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    guard: {
      allowPrivateHosts: config.allowPrivateHosts,
      allowInsecure: config.allowInsecure
    },
    onRetry: (info) => {
      logger.debug(`retry ${info.attempt}/${info.maxAttempts - 1} in ${info.delayMs}ms \u2014 ${info.reason}`, {
        url: info.url
      });
    }
  });
  return { config, logger, http, signal: options.signal, flags: options.flags };
}
function createInterruptController(onFirst) {
  const controller = new AbortController();
  let interrupted = false;
  const handler = () => {
    if (interrupted) {
      process.stderr.write("\n");
      process.exit(130);
    }
    interrupted = true;
    onFirst?.();
    controller.abort(new Error("Interrupted by user"));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    controller,
    dispose: () => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    }
  };
}

// src/cli/options.ts
function parseInteger(flag, value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be an integer between ${min} and ${max} (got "${value}").`);
  }
  return parsed;
}
function collect(value, previous = []) {
  return [...previous, ...value.split(",").map((v) => v.trim()).filter(Boolean)];
}
function parseKinds(values) {
  const out = [];
  for (const value of values) {
    const kind = value.toLowerCase();
    if (!MEDIA_KINDS.includes(kind)) {
      throw new UsageError(`Unknown media kind "${value}".`, {
        hint: `Valid kinds: ${MEDIA_KINDS.join(", ")}.`
      });
    }
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}
function parseExtensions(values) {
  return [...new Set(values.map((v) => v.replace(/^[.*]+/, "").toLowerCase()).filter(Boolean))];
}
function parseRegex(flag, value) {
  try {
    return new RegExp(value, "i");
  } catch (error) {
    throw new UsageError(`${flag} is not a valid regular expression: ${value}`, { cause: error });
  }
}
function parseSelection(expression, total) {
  const trimmed = expression.trim().toLowerCase();
  if (trimmed === "") {
    throw new UsageError("--select was empty.", { hint: "Try --select 1,3,5-8 or --all." });
  }
  if (trimmed === "all" || trimmed === "*") {
    return Array.from({ length: total }, (_, index) => index);
  }
  const indices = /* @__PURE__ */ new Set();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)\s*(?:-|\.\.)\s*(\d+)$/.exec(token);
    if (range !== null) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      assertInRange(start, total, token);
      assertInRange(end, total, token);
      const [low, high] = start <= end ? [start, end] : [end, start];
      for (let n = low; n <= high; n++) indices.add(n - 1);
      continue;
    }
    if (!/^\d+$/.test(token)) {
      throw new UsageError(`Invalid selection token "${token}".`, {
        hint: "Use numbers and ranges, e.g. --select 1,3,5-8."
      });
    }
    assertInRange(Number(token), total, token);
    indices.add(Number(token) - 1);
  }
  return [...indices].sort((a, b) => a - b);
}
function assertInRange(value, total, token) {
  if (value < 1 || value > total) {
    throw new UsageError(`Selection "${token}" is out of range (1\u2013${total}).`);
  }
}
function resolveReferer(policy, pageUrl) {
  if (policy === "none" || policy === "") return void 0;
  if (policy === "auto") return pageUrl?.href;
  return policy;
}

// src/cli/commands/get.ts
import path14 from "path";

// src/core/download/engine.ts
import { createWriteStream } from "fs";
import { readFile as readFile2, writeFile as writeFile2, rename as rename2, truncate as truncateFile } from "fs/promises";
import path6 from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

// src/core/download/filename.ts
import path5 from "path";
var WINDOWS_RESERVED = /* @__PURE__ */ new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);
var ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
var INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
var MAX_BYTES = 180;
var encoder = new TextEncoder();
function sanitizeFilename(input2, fallback = "download") {
  let name = path5.basename(input2.replace(/[\\/]+/g, "/"));
  name = name.replace(INVISIBLE, "").replace(ILLEGAL, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (name === "") return fallback;
  const ext = path5.extname(name);
  const stem = path5.basename(name, ext);
  if (stem === "" || WINDOWS_RESERVED.has(stem.toLowerCase())) {
    return clampBytes(`${fallback}${ext}`, ext);
  }
  return clampBytes(name, ext);
}
function clampBytes(name, ext) {
  if (encoder.encode(name).length <= MAX_BYTES) return name;
  const extBytes = encoder.encode(ext).length;
  const budget = Math.max(1, MAX_BYTES - extBytes);
  const stem = path5.basename(name, ext);
  let out = "";
  let used = 0;
  for (const char of stem) {
    const size = encoder.encode(char).length;
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd() || "download"}${ext}`;
}
var KNOWN_EXTENSIONS = /* @__PURE__ */ new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".wma",
  ".alac",
  ".aiff",
  ".mp4",
  ".m4v",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".pdf",
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg"
]);
var MIME_EXTENSIONS = {
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/x-m4a": ".m4a",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/zip": ".zip"
};
function extensionFromUrl(url) {
  const ext = path5.extname(decodeSafe(url.pathname)).toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : void 0;
}
function extensionFromContentType(contentType) {
  if (contentType === null || contentType === void 0) return void 0;
  const mime = contentType.split(";")[0]?.trim().toLowerCase();
  return mime !== void 0 ? MIME_EXTENSIONS[mime] : void 0;
}
function filenameFromContentDisposition(header) {
  if (header === null || header === void 0) return void 0;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended?.[1] !== void 0) {
    const value = extended[1].trim();
    const match = /^([\w-]*)'([\w-]*)'(.*)$/.exec(value);
    const raw = match?.[3] ?? value;
    const decoded = decodeSafe(raw);
    const clean = sanitizeFilename(decoded, "");
    if (clean !== "") return clean;
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const candidate = plain?.[2] ?? plain?.[1];
  if (candidate !== void 0) {
    const clean = sanitizeFilename(candidate.trim(), "");
    if (clean !== "") return clean;
  }
  return void 0;
}
function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function titleFromUrl(url) {
  const segment = decodeSafe(url.pathname).split("/").filter(Boolean).pop();
  if (segment === void 0) return void 0;
  const stem = path5.basename(segment, path5.extname(segment));
  const pretty = stem.replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
  return pretty.length >= 2 ? pretty : void 0;
}
function buildFilename(options) {
  const fromHeader = filenameFromContentDisposition(options.contentDisposition);
  if (fromHeader !== void 0 && path5.extname(fromHeader) !== "") return fromHeader;
  const stem = sanitizeFilename(
    options.title ?? fromHeader ?? titleFromUrl(options.url) ?? "download",
    "download"
  );
  const existingExt = path5.extname(stem).toLowerCase();
  if (KNOWN_EXTENSIONS.has(existingExt)) return stem;
  const ext = extensionFromUrl(options.url) ?? extensionFromContentType(options.contentType) ?? options.defaultExtension ?? "";
  return sanitizeFilename(`${stem}${ext}`, "download");
}

// src/core/util/pool.ts
async function mapPool(items, worker, options) {
  const limit = Math.max(1, Math.floor(options.limit));
  const results = new Array(items.length);
  let cursor = 0;
  const runNext = async () => {
    for (; ; ) {
      if (options.signal?.aborted === true) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  const abortReason = options.signal?.reason ?? new Error("Aborted");
  for (let i = 0; i < results.length; i++) {
    results[i] ??= { status: "rejected", reason: abortReason };
  }
  return results;
}
function delay(ms, signal) {
  return new Promise((resolve2, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/core/download/engine.ts
var PART_SUFFIX = ".vxpart";
var META_SUFFIX = ".vxpart.json";
var Task = class {
  constructor(request) {
    this.request = request;
  }
  request;
  state = "queued";
  received = 0;
  total;
  resumedFrom = 0;
  attempt = 1;
  destination;
  error;
  speed = 0;
  lastSampleAt = 0;
  lastSampleBytes = 0;
  beginSampling(now, baseline) {
    this.lastSampleAt = now;
    this.lastSampleBytes = baseline;
    this.speed = 0;
  }
  sample(now) {
    const elapsed = now - this.lastSampleAt;
    if (elapsed < 150) return;
    const instant = (this.received - this.lastSampleBytes) * 1e3 / elapsed;
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3;
    this.lastSampleAt = now;
    this.lastSampleBytes = this.received;
  }
  snapshot() {
    const remaining = this.total !== void 0 ? this.total - this.received : void 0;
    return {
      id: this.request.id,
      title: this.request.title,
      state: this.state,
      received: this.received,
      total: this.total,
      speed: this.state === "downloading" ? this.speed : 0,
      etaMs: remaining !== void 0 && remaining > 0 && this.speed > 1 ? remaining / this.speed * 1e3 : void 0,
      resumedFrom: this.resumedFrom,
      attempt: this.attempt,
      destination: this.destination,
      error: this.error
    };
  }
};
var DownloadEngine = class {
  constructor(http, options = {}) {
    this.http = http;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.retries = Math.max(0, options.retries ?? 3);
    this.retryDelayMs = options.retryDelayMs ?? 800;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 6e4;
    this.conflict = options.conflict ?? "rename";
    this.resume = options.resume ?? true;
    this.dryRun = options.dryRun ?? false;
    this.onUpdate = options.onUpdate;
  }
  http;
  concurrency;
  retries;
  retryDelayMs;
  stallTimeoutMs;
  conflict;
  resume;
  dryRun;
  onUpdate;
  async run(requests, signal) {
    if (requests.length === 0) return [];
    const outputDirs = new Set(requests.map((request) => request.outputDir));
    for (const dir of outputDirs) await ensureWritableDir(dir);
    const settled = await mapPool(
      requests,
      async (request) => this.runTask(new Task(request), signal),
      { limit: this.concurrency, signal }
    );
    return settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      const request = requests[index];
      const cancelled = isAbortError(entry.reason) || signal?.aborted === true;
      return {
        request,
        state: cancelled ? "cancelled" : "failed",
        path: void 0,
        bytes: 0,
        durationMs: 0,
        resumed: false,
        error: entry.reason instanceof Error ? entry.reason : new Error(errorMessage(entry.reason))
      };
    });
  }
  publish(task) {
    this.onUpdate?.(task.snapshot());
  }
  async runTask(task, signal) {
    const startedAt = Date.now();
    const finish = (state, extra = {}) => {
      task.state = state;
      this.publish(task);
      return {
        request: task.request,
        state,
        path: task.destination,
        bytes: task.received,
        durationMs: Date.now() - startedAt,
        resumed: task.resumedFrom > 0,
        error: void 0,
        ...extra
      };
    };
    try {
      task.state = "probing";
      this.publish(task);
      const probe = await this.http.probe(task.request.url, {
        signal,
        ...task.request.headers !== void 0 ? { headers: { ...task.request.headers } } : {},
        ...task.request.referer !== void 0 ? { referer: task.request.referer } : {}
      });
      task.total = probe.size ?? task.request.expectedSize;
      const filename = buildFilename({
        title: task.request.filename ?? task.request.title,
        url: probe.url,
        contentDisposition: probe.contentDisposition,
        contentType: probe.contentType
      });
      const resolved = await this.resolveDestination(task.request.outputDir, filename);
      if (resolved === null) {
        task.destination = path6.join(task.request.outputDir, filename);
        return finish("skipped");
      }
      task.destination = resolved;
      if (this.dryRun) {
        task.received = task.total ?? 0;
        return finish("completed");
      }
      await this.transferWithRetry(task, probe, signal);
      return finish("completed");
    } catch (error) {
      if (isAbortError(error) || signal?.aborted === true) {
        task.error = "cancelled";
        return finish("cancelled", { error: new CancelledError() });
      }
      const failure = this.explain(error, task.request);
      task.error = failure.message;
      return finish("failed", { error: failure });
    }
  }
  explain(error, request) {
    const normalised = error instanceof Error ? error : new Error(errorMessage(error));
    if (request.failureHint === void 0) return normalised;
    if (!(normalised instanceof HttpError) || normalised.status !== 401 && normalised.status !== 403) {
      return normalised;
    }
    return new HttpError(normalised.status, String(normalised.details?.["url"] ?? request.url), {
      hint: request.failureHint,
      cause: normalised
    });
  }
  async resolveDestination(outputDir, filename) {
    const direct = path6.join(outputDir, filename);
    if (!await pathExists(direct)) return direct;
    switch (this.conflict) {
      case "skip":
        return null;
      case "overwrite":
        return direct;
      case "rename":
        return uniquePath(outputDir, filename);
    }
  }
  async transferWithRetry(task, probe, signal) {
    const destination = task.destination;
    const partPath = `${destination}${PART_SUFFIX}`;
    const metaPath = `${destination}${META_SUFFIX}`;
    let lastError2;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      task.attempt = attempt;
      try {
        const offset = await this.resolveResumeOffset(partPath, metaPath, probe);
        task.resumedFrom = offset;
        task.received = offset;
        task.state = "downloading";
        this.publish(task);
        await this.transfer(task, probe, partPath, metaPath, offset, signal);
        await this.finalize(task, partPath, metaPath, destination);
        return;
      } catch (error) {
        if (isAbortError(error) || signal?.aborted === true) throw error;
        if (error instanceof HttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
          throw error;
        }
        lastError2 = error;
        if (attempt > this.retries) break;
        task.state = "retrying";
        task.error = errorMessage(error);
        this.publish(task);
        await delay(computeBackoff(attempt, this.retryDelayMs, null), signal);
      }
    }
    throw lastError2 instanceof Error ? lastError2 : new Error(errorMessage(lastError2));
  }
  async resolveResumeOffset(partPath, metaPath, probe) {
    const existing = await fileSize(partPath);
    if (existing === 0) return 0;
    if (!this.resume || !probe.supportsRanges) {
      await removeQuietly(partPath);
      await removeQuietly(metaPath);
      return 0;
    }
    const meta = await readMetadata(metaPath);
    const matches = meta !== void 0 && meta.url === probe.url.href && meta.etag === probe.etag && meta.lastModified === probe.lastModified && meta.size === (probe.size ?? null);
    const sane = probe.size === void 0 || existing < probe.size;
    if (matches && sane) return existing;
    await removeQuietly(partPath);
    await removeQuietly(metaPath);
    return 0;
  }
  async transfer(task, probe, partPath, metaPath, offset, signal) {
    const headers = { accept: "*/*", ...task.request.headers };
    if (offset > 0) headers["range"] = `bytes=${offset}-`;
    const { response } = await this.http.request(probe.url, {
      method: "GET",
      headers,
      signal,
      retries: 0,
      ...task.request.referer !== void 0 ? { referer: task.request.referer } : {}
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => void 0);
      if (response.status === 416) {
        await removeQuietly(partPath);
        await removeQuietly(metaPath);
      }
      throw new HttpError(response.status, probe.url.href, { hint: httpStatusHint(response.status) });
    }
    const resuming = offset > 0 && response.status === 206;
    if (offset > 0 && !resuming) {
      await truncateFile(partPath, 0).catch(() => removeQuietly(partPath));
      task.resumedFrom = 0;
      task.received = 0;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0) {
      task.total = (resuming ? offset : 0) + declared;
    }
    if (response.body === null) {
      throw new VectraxError("The server returned an empty response body.", { code: "E_HTTP" });
    }
    await writeMetadata(metaPath, {
      url: probe.url.href,
      etag: probe.etag,
      lastModified: probe.lastModified,
      size: probe.size ?? null,
      version: 1
    });
    const stallController = new AbortController();
    let lastByteAt = Date.now();
    task.beginSampling(lastByteAt, task.received);
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > this.stallTimeoutMs) {
        stallController.abort(new Error(`Stalled: no data for ${Math.round(this.stallTimeoutMs / 1e3)}s`));
      }
    }, 1e3).unref();
    const signals = [stallController.signal];
    if (signal !== void 0) signals.push(signal);
    const counter = new Transform({
      transform: (chunk, _encoding, callback) => {
        task.received += chunk.length;
        lastByteAt = Date.now();
        task.sample(lastByteAt);
        this.publish(task);
        callback(null, chunk);
      }
    });
    const sink = createWriteStream(partPath, { flags: resuming ? "a" : "w" });
    try {
      await pipeline(Readable.fromWeb(response.body), counter, sink, {
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (stallController.signal.aborted && signal?.aborted !== true) {
        throw new VectraxError(errorMessage(stallController.signal.reason), {
          code: "E_TIMEOUT",
          hint: "The connection stalled. Re-run to resume from where it stopped."
        });
      }
      throw error;
    } finally {
      clearInterval(watchdog);
    }
  }
  async finalize(task, partPath, metaPath, destination) {
    const written = await fileSize(partPath);
    if (task.total !== void 0 && task.total > 0 && written !== task.total) {
      throw new VectraxError(
        `Incomplete download: expected ${task.total} bytes, wrote ${written}.`,
        { code: "E_NETWORK", hint: "Re-run to resume the transfer." }
      );
    }
    if (written === 0) {
      await removeQuietly(partPath);
      await removeQuietly(metaPath);
      throw new VectraxError("The server returned an empty file.", { code: "E_HTTP" });
    }
    try {
      await rename2(partPath, destination);
    } catch (error) {
      if (error.code === "EXDEV") await moveFile(partPath, destination);
      else throw wrapFsError(error, "finalize download", destination);
    }
    await removeQuietly(metaPath);
    task.received = written;
    task.total = written;
  }
};
async function readMetadata(metaPath) {
  try {
    const parsed = JSON.parse(await readFile2(metaPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1) {
      return parsed;
    }
  } catch {
  }
  return void 0;
}
async function writeMetadata(metaPath, meta) {
  try {
    await writeFile2(metaPath, JSON.stringify(meta), "utf8");
  } catch {
  }
}

// src/core/scrape/extract.ts
import path7 from "path";
var HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  laquo: "\xAB",
  raquo: "\xBB",
  bull: "\u2022",
  middot: "\xB7",
  times: "\xD7",
  divide: "\xF7",
  deg: "\xB0",
  copy: "\xA9",
  reg: "\xAE",
  trade: "\u2122",
  euro: "\u20AC",
  pound: "\xA3",
  yen: "\xA5",
  cent: "\xA2",
  sect: "\xA7",
  para: "\xB6",
  dagger: "\u2020",
  prime: "\u2032",
  Prime: "\u2033"
};
function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    const known = HTML_ENTITIES[entity] ?? HTML_ENTITIES[entity.toLowerCase()];
    if (known !== void 0) return known;
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 1114111) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
    return whole;
  });
}
function unescapeJsonish(value) {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, hex2) => String.fromCharCode(Number.parseInt(hex2, 16))).replace(/\\\//g, "/").replace(/\\"/g, '"');
}
function textContent(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function extensionOf(url) {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
  }
  const ext = path7.extname(pathname).slice(1).toLowerCase();
  return ext === "" ? void 0 : ext;
}
function resolve(href, base) {
  const value = unescapeJsonish(decodeEntities(href)).trim();
  if (value === "" || value.startsWith("#")) return void 0;
  if (/^(javascript|data|mailto|tel|blob):/i.test(value)) return void 0;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : void 0;
  } catch {
    return void 0;
  }
}
function resolveBase(html, documentUrl) {
  const match = /<base[^>]+href=["']([^"']+)["']/i.exec(html);
  if (match?.[1] === void 0) return documentUrl;
  try {
    return new URL(decodeEntities(match[1]), documentUrl);
  } catch {
    return documentUrl;
  }
}
function extractPageTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] !== void 0 ? textContent(match[1]) : "";
  return title === "" ? void 0 : title;
}
var MEDIA_ATTRIBUTES = [
  "src",
  "data-src",
  "data-url",
  "data-file",
  "data-mp3",
  "data-audio",
  "data-video",
  "data-track",
  "data-download",
  "content"
];
var JSON_KEYS = ["file", "url", "src", "source", "mp3", "audio", "stream", "download", "link", "path"];
function extractMedia(html, options) {
  const base = resolveBase(html, options.baseUrl);
  const accepted = new Set(options.extensions.map((e) => e.replace(/^\./, "").toLowerCase()));
  const raw = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const attributes = match[1] ?? "";
    const href = attribute(attributes, "href");
    if (href === void 0) continue;
    const text2 = textContent(match[2] ?? "");
    const title = firstNonEmpty(text2, attribute(attributes, "download"), attribute(attributes, "title"), attribute(attributes, "aria-label"));
    raw.push({ href, title, source: "anchor", titleRank: text2 !== "" ? 4 : 3 });
  }
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const href = attribute(match[1] ?? "", "href");
    if (href !== void 0) raw.push({ href, title: void 0, source: "anchor", titleRank: 1 });
  }
  const tagRe = /<(?:audio|video|source|embed|iframe|meta|div|li|span|button)\b([^>]*)>/gi;
  for (const match of html.matchAll(tagRe)) {
    const attributes = match[1] ?? "";
    const title = firstNonEmpty(
      attribute(attributes, "data-title"),
      attribute(attributes, "data-name"),
      attribute(attributes, "title"),
      attribute(attributes, "aria-label"),
      attribute(attributes, "alt")
    );
    for (const name of MEDIA_ATTRIBUTES) {
      const value = attribute(attributes, name);
      if (value !== void 0) {
        raw.push({ href: value, title, source: "media-tag", titleRank: title !== void 0 ? 3 : 1 });
      }
    }
  }
  const jsonRe = new RegExp(`["'](?:${JSON_KEYS.join("|")})["']\\s*:\\s*["']([^"']{4,2048})["']`, "gi");
  for (const match of html.matchAll(jsonRe)) {
    const value = match[1];
    if (value !== void 0) raw.push({ href: value, title: void 0, source: "embedded-json", titleRank: 1 });
  }
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>()\\[\]{}]+/gi)) {
    const value = match[0].replace(/[.,;:!?]+$/, "");
    raw.push({ href: value, title: void 0, source: "raw-scan", titleRank: 0 });
  }
  const merged = /* @__PURE__ */ new Map();
  for (const entry of raw) {
    const url = resolve(entry.href, base);
    if (url === void 0) continue;
    const extension = extensionOf(url);
    if (extension === void 0 || !accepted.has(extension)) continue;
    const key = normalizeUrl(url);
    const cleanTitle = entry.title !== void 0 ? tidyTitle(entry.title) : void 0;
    const title = cleanTitle ?? titleFromPath(url) ?? extractPageTitle(html) ?? "download";
    if (options.match !== void 0 && !options.match.test(key) && !options.match.test(title)) continue;
    const candidate = {
      url: key,
      title,
      kind: kindForExtension(extension),
      extension,
      quality: detectQuality(cleanTitle, url.pathname, url.search),
      source: entry.source,
      titleRank: cleanTitle !== void 0 ? entry.titleRank : 0
    };
    const existing = merged.get(key);
    if (existing === void 0 || candidate.titleRank > existing.titleRank) {
      merged.set(key, existing === void 0 ? candidate : { ...existing, ...candidate });
    }
  }
  const items = [...merged.values()].map(({ titleRank: _titleRank, ...item }) => item);
  return {
    pageTitle: extractPageTitle(html),
    items,
    likelyDynamic: items.length === 0 && looksDynamic(html)
  };
}
function attribute(attributes, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = re.exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === void 0 || value.trim() === "" ? void 0 : value.trim();
}
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== void 0 && value.trim() !== "") return value.trim();
  }
  return void 0;
}
function tidyTitle(value) {
  const clean = decodeEntities(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/^[\s|·•\-–—]+|[\s|·•\-–—]+$/g, "").trim();
  if (clean.length < 2 || clean.length > 200) return void 0;
  if (/^(download|دانلود|link|here|click|play|listen)$/i.test(clean)) return void 0;
  return clean;
}
function titleFromPath(url) {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
  }
  const segment = pathname.split("/").filter(Boolean).pop();
  if (segment === void 0) return void 0;
  const stem = path7.basename(segment, path7.extname(segment)).replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
  return stem.length >= 2 ? stem : void 0;
}
function looksDynamic(html) {
  const scriptBytes = [...html.matchAll(/<script\b[\s\S]*?<\/script>/gi)].reduce((n, m) => n + m[0].length, 0);
  const hasAppRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(html);
  return hasAppRoot || scriptBytes > html.length * 0.4;
}

// src/core/providers/page.ts
var TEXTUAL = /^(text\/|application\/(xhtml|xml|json))/i;
var pageProvider = {
  id: "page",
  label: "web page",
  supports() {
    return true;
  },
  async resolve(target, context) {
    const accepted = [
      .../* @__PURE__ */ new Set([...extensionsForKinds(context.kinds), ...context.extensions ?? []])
    ];
    const acceptedSet = new Set(accepted);
    const urlExtension = target.pathname.split(".").pop()?.toLowerCase();
    if (urlExtension !== void 0 && acceptedSet.has(urlExtension)) {
      return { pageUrl: target, items: [directCandidate(target)], direct: true };
    }
    const probe = await context.http.probe(target, {
      ...context.signal !== void 0 ? { signal: context.signal } : {}
    });
    if (probe.contentType !== null && !TEXTUAL.test(probe.contentType)) {
      return { pageUrl: probe.url, items: [directCandidate(probe.url)], direct: true };
    }
    const { body, url } = await context.http.text(target, {
      ...context.signal !== void 0 ? { signal: context.signal } : {}
    });
    const extracted = extractMedia(body, {
      baseUrl: url,
      extensions: accepted,
      match: context.match
    });
    return {
      pageUrl: url,
      title: extracted.pageTitle,
      items: extracted.items,
      direct: false,
      likelyDynamic: extracted.likelyDynamic
    };
  }
};
function directCandidate(url) {
  const segment = decodeSafe2(url.pathname.split("/").filter(Boolean).pop() ?? "download");
  const extension = segment.includes(".") ? segment.split(".").pop()?.toLowerCase() : void 0;
  const title = segment.replace(/\.[^.]+$/, "").replace(/[_+]+/g, " ").trim();
  const candidate = {
    url: normalizeUrl(url),
    title: title === "" ? "download" : title,
    kind: kindForExtension(extension),
    extension,
    quality: detectQuality(title, url.pathname),
    source: "direct"
  };
  return candidate;
}
function decodeSafe2(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// src/core/providers/types.ts
function bareHost(url) {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// src/core/providers/unsupported.ts
var DRM_SOURCES = [
  {
    domains: ["spotify.com", "spotify.link"],
    name: "Spotify",
    reason: "every Spotify stream is encrypted under Widevine DRM"
  },
  {
    domains: ["music.apple.com", "itunes.apple.com"],
    name: "Apple Music",
    reason: "Apple Music streams are DRM-protected"
  },
  {
    domains: ["tidal.com", "listen.tidal.com"],
    name: "Tidal",
    reason: "Tidal streams are DRM-protected"
  },
  {
    domains: ["deezer.com"],
    name: "Deezer",
    reason: "Deezer streams are DRM-protected"
  },
  {
    domains: ["netflix.com", "primevideo.com", "disneyplus.com", "hulu.com", "max.com"],
    name: "that streaming service",
    reason: "its video streams are DRM-protected"
  }
];
function blockedSourceFor(url) {
  const host = bareHost(url);
  return DRM_SOURCES.find((source) => source.domains.some((domain) => hostMatches(host, domain)));
}
var unsupportedProvider = {
  id: "unsupported",
  label: "unsupported source",
  supports(url) {
    return blockedSourceFor(url) !== void 0;
  },
  resolve(url) {
    const source = blockedSourceFor(url);
    throw new VectraxError(`Vectrax cannot download from ${source.name}.`, {
      code: "E_URL_BLOCKED",
      exitCode: ExitCode.UsageError,
      hint: `Vectrax does not circumvent DRM, and ${source.reason}. Supported sources: YouTube, and direct media links on any page.`,
      details: { url: url.href, source: source.name }
    });
  }
};

// src/core/providers/youtube.ts
var INNERTUBE_BASE = "https://www.youtube.com/youtubei/v1";
var IOS_CLIENT = {
  clientName: "IOS",
  clientVersion: "20.03.02",
  deviceMake: "Apple",
  deviceModel: "iPhone16,2",
  osName: "iPhone",
  osVersion: "18.2.1.22C161",
  hl: "en",
  gl: "US"
};
var IOS_USER_AGENT = "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)";
var ANDROID_VR_CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.60.19",
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  osName: "Android",
  osVersion: "12",
  androidSdkVersion: 32,
  hl: "en",
  gl: "US"
};
var ANDROID_VR_USER_AGENT = "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip";
var BROWSER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var VIDEO_ID = /^[\w-]{11}$/;
var PLAYLIST_ID = /^[\w-]{12,42}$/;
function parseYouTubeUrl(url) {
  const host = bareHost(url);
  const segments = url.pathname.split("/").filter(Boolean);
  if (hostMatches(host, "youtu.be")) {
    const id = segments[0];
    return id !== void 0 && VIDEO_ID.test(id) ? { videoId: id, ...listParam(url) } : void 0;
  }
  if (!hostMatches(host, "youtube.com") && !hostMatches(host, "youtube-nocookie.com")) return void 0;
  const list = listParam(url);
  const v = url.searchParams.get("v");
  if (v !== null && VIDEO_ID.test(v)) return { videoId: v, ...list };
  if (segments.length >= 2 && ["shorts", "embed", "live", "v"].includes(segments[0])) {
    const id = segments[1];
    if (VIDEO_ID.test(id)) return { videoId: id, ...list };
  }
  if (segments[0] === "playlist" && list.playlistId !== void 0) return list;
  return list.playlistId !== void 0 ? list : void 0;
}
function listParam(url) {
  const list = url.searchParams.get("list");
  if (list === null || !PLAYLIST_ID.test(list) || list === "WL" || list === "LL") return {};
  return { playlistId: list };
}
var PLAYER_CLIENTS = {
  ios: { context: IOS_CLIENT, userAgent: IOS_USER_AGENT, id: "5" },
  androidVr: { context: ANDROID_VR_CLIENT, userAgent: ANDROID_VR_USER_AGENT, id: "28" }
};
async function fetchPlayer(http, videoId, client = "ios", signal) {
  const profile = PLAYER_CLIENTS[client];
  return http.json(`${INNERTUBE_BASE}/player?prettyPrint=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": profile.userAgent,
      "x-youtube-client-name": profile.id,
      "x-youtube-client-version": profile.context.clientVersion,
      origin: "https://www.youtube.com"
    },
    body: JSON.stringify({
      videoId,
      context: { client: profile.context },
      contentCheckOk: true,
      racyCheckOk: true
    }),
    retryStatuses: [403],
    retries: 4,
    ...signal !== void 0 ? { signal } : {}
  });
}
function playabilityError(videoId, status) {
  const reason = status?.reason ?? status?.status ?? "unknown reason";
  const hints = {
    LOGIN_REQUIRED: "This video is private or age-restricted; Vectrax does not sign in.",
    AGE_VERIFICATION_REQUIRED: "This video requires age verification, which needs a signed-in account.",
    UNPLAYABLE: "YouTube will not serve this video to an anonymous client.",
    LIVE_STREAM_OFFLINE: "The live stream is not currently broadcasting.",
    ERROR: "The video may have been removed or made private."
  };
  return new VectraxError(`YouTube refused video ${videoId}: ${reason}`, {
    code: "E_NO_MEDIA",
    exitCode: ExitCode.NoResults,
    ...status?.status !== void 0 && hints[status.status] !== void 0 ? { hint: hints[status.status] } : {},
    details: { videoId, status: status?.status }
  });
}
function extensionFor(format2) {
  const mime = format2.mimeType ?? "";
  if (mime.includes("audio/mp4")) return "m4a";
  if (mime.includes("audio/webm")) return "webm";
  if (mime.includes("video/mp4")) return "mp4";
  if (mime.includes("video/webm")) return "webm";
  return "bin";
}
var TAGGABLE_AUDIO = "m4a";
var AUDIO_OVERSHOOT = 1.2;
function audioKbps(format2) {
  return Math.round((format2.bitrate ?? 0) / 1e3);
}
function selectAudio(formats, targets) {
  const audio = formats.filter((format2) => format2.mimeType?.startsWith("audio/") === true);
  if (audio.length === 0) return void 0;
  const choice = chooseByCeiling(audio, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);
  if (choice === void 0) return void 0;
  if (extensionFor(choice.item) === TAGGABLE_AUDIO) {
    return { format: choice.item, note: describeShortfall(choice, "kbps", "YouTube") };
  }
  const taggable = audio.filter((format2) => extensionFor(format2) === TAGGABLE_AUDIO);
  const preferred = chooseByCeiling(taggable, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);
  if (preferred !== void 0 && preferred.satisfied) {
    return { format: preferred.item, note: describeShortfall(preferred, "kbps", "YouTube") };
  }
  return { format: choice.item, note: describeShortfall(choice, "kbps", "YouTube") };
}
function selectVideo(formats, targets) {
  const muxed = formats.filter(
    (format2) => format2.mimeType?.startsWith("video/") === true && format2.audioQuality !== void 0
  );
  if (muxed.length === 0) return void 0;
  const choice = chooseByCeiling(muxed, (format2) => format2.height ?? 0, targets.videoHeight);
  if (choice === void 0) return void 0;
  const adaptiveCeiling = Math.max(
    0,
    ...formats.filter((f) => f.mimeType?.startsWith("video/") === true).map((f) => f.height ?? 0)
  );
  const wantedMore = targets.videoHeight === MAX || targets.videoHeight > choice.value;
  const note = wantedMore && adaptiveCeiling > choice.value ? `${choice.value}p is the highest YouTube serves with audio included. Higher resolutions up to ${adaptiveCeiling}p exist only as separate video-only streams, which Vectrax does not multiplex.` : describeShortfall(choice, "p", "YouTube");
  return { format: choice.item, note };
}
function selectFormat(formats, media, targets) {
  const usable = formats.filter((format2) => typeof format2.url === "string" && format2.url !== "");
  if (usable.length === 0) return void 0;
  if (media === "video") return selectVideo(usable, targets) ?? selectAudio(usable, targets);
  return selectAudio(usable, targets) ?? selectVideo(usable, targets);
}
var TITLE_NOISE = /\s*[([]\s*(?:(?:official|oficial|officiel|offizielles?)\s*)?(?:music\s*|musik\s*)?(?:video|audio|vídeo|videoclip|visualizer|visualiser|lyric[s]?(?:\s*video)?|letra|performance\s*video|clip)\s*(?:oficial|official|officiel)?\s*[)\]]/gi;
var QUALITY_NOISE = /\s*[([]\s*(?:hd|hq|4k|8k|full\s*hd|remaster(?:ed)?(?:\s*\d{4})?|\d{3,4}p|4k\s*remaster(?:ed)?)\s*[)\]]/gi;
function normaliseName(value) {
  return value.toLowerCase().replace(/\b(vevo|official|music|records|tv)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}
function splitArtistTitle(name, channel) {
  const cleaned = name.replace(TITLE_NOISE, " ").replace(QUALITY_NOISE, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, "").trim();
  const separator = /\s+[-–—]\s+/.exec(cleaned);
  if (separator !== null && separator.index > 0) {
    const left = cleaned.slice(0, separator.index).trim();
    const right = cleaned.slice(separator.index + separator[0].length).trim();
    if (left !== "" && right !== "") {
      const channelKey = channel !== void 0 ? normaliseName(channel) : "";
      if (channelKey !== "") {
        const leftMatches = normaliseName(left).includes(channelKey) || channelKey.includes(normaliseName(left));
        const rightCore = right.replace(/\s*(?:ft\.?|feat\.?|featuring|con)\s+.*$/i, "").trim();
        const rightMatches = normaliseName(rightCore).includes(channelKey) || channelKey.includes(normaliseName(rightCore));
        if (rightMatches && !leftMatches) return { artist: right, title: left };
      }
      return { artist: left, title: right };
    }
  }
  return { title: cleaned === "" ? name : cleaned, ...channel !== void 0 ? { artist: channel } : {} };
}
function bestThumbnail(player) {
  const thumbnails = player.videoDetails?.thumbnail?.thumbnails ?? [];
  const best = [...thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.url;
}
function buildMetadata(player, watchUrl) {
  const details = player.videoDetails ?? {};
  const { artist, title } = splitArtistTitle(details.title ?? "video", details.author);
  const published = player.microformat?.playerMicroformatRenderer?.publishDate ?? player.microformat?.playerMicroformatRenderer?.uploadDate;
  const year = Number.parseInt((published ?? "").slice(0, 4), 10);
  return {
    title,
    ...artist !== void 0 ? { artist } : {},
    ...details.author !== void 0 ? { albumArtist: details.author } : {},
    ...Number.isFinite(year) && year > 0 ? { year } : {},
    sourceUrl: watchUrl
  };
}
var watchUrlFor = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
function extractPlaylistEntries(data) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node;
    const contentType = record["contentType"];
    if (typeof record["contentId"] === "string" && typeof contentType === "string" && contentType.includes("VIDEO")) {
      add(record["contentId"], lockupTitle(record), lockupAuthor(record));
    }
    if (typeof record["videoId"] === "string" && record["title"] !== void 0) {
      add(record["videoId"], readText(record["title"]), readText(record["shortBylineText"]));
    }
    Object.values(record).forEach(visit);
  };
  const add = (videoId, title, author) => {
    if (!VIDEO_ID.test(videoId) || seen.has(videoId)) return;
    seen.add(videoId);
    entries.push({ videoId, title, author });
  };
  visit(data);
  return entries;
}
function lockupTitle(record) {
  const metadata = record["metadata"];
  const view = metadata?.["lockupMetadataViewModel"];
  const title = view?.["title"];
  return typeof title?.["content"] === "string" ? title["content"] : void 0;
}
function lockupAuthor(record) {
  const json = JSON.stringify(record["metadata"] ?? {});
  const match = /"metadataParts":\[\{"text":\{"content":"((?:[^"\\]|\\.)*)"/.exec(json);
  if (match?.[1] === void 0) return void 0;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return void 0;
  }
}
function readText(value) {
  if (value === null || typeof value !== "object") return void 0;
  const record = value;
  if (typeof record["simpleText"] === "string") return record["simpleText"];
  const runs = record["runs"];
  if (Array.isArray(runs)) {
    const text2 = runs.map((run3) => run3["text"]).filter((t) => typeof t === "string").join("");
    return text2 === "" ? void 0 : text2;
  }
  return void 0;
}
function parseInitialData(html) {
  const match = /ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s.exec(html) ?? /ytInitialData"\]\s*=\s*(\{.+?\})\s*;/s.exec(html);
  if (match?.[1] === void 0) return void 0;
  try {
    return JSON.parse(match[1]);
  } catch {
    return void 0;
  }
}
function extractPlaylistTitle(data) {
  const json = JSON.stringify(data ?? {});
  const match = /"microformatDataRenderer":\{"urlCanonical":"[^"]*","title":"((?:[^"\\]|\\.)*)"/.exec(json);
  if (match?.[1] === void 0) return void 0;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return void 0;
  }
}
var PLAYLIST_RESOLVE_CONCURRENCY = 3;
var youtubeProvider = {
  id: "youtube",
  label: "YouTube",
  supports(url) {
    return parseYouTubeUrl(url) !== void 0;
  },
  async resolve(url, context) {
    const target = parseYouTubeUrl(url);
    if (target === void 0) {
      throw new VectraxError(`Not a recognisable YouTube URL: ${url.href}`, { code: "E_URL_INVALID" });
    }
    if (target.videoId !== void 0) {
      const item = await resolveVideo(target.videoId, context);
      return { pageUrl: new URL(watchUrlFor(target.videoId)), items: [item], direct: true };
    }
    return resolvePlaylist(target.playlistId, context);
  }
};
function formatsOf(player) {
  return [...player.streamingData?.formats ?? [], ...player.streamingData?.adaptiveFormats ?? []];
}
function hasCombinedVideo(formats) {
  return formats.some(
    (format2) => format2.mimeType?.startsWith("video/") === true && format2.audioQuality !== void 0 && typeof format2.url === "string"
  );
}
async function resolveVideo(videoId, context) {
  const player = await fetchPlayer(context.http, videoId, "ios", context.signal);
  const status = player.playabilityStatus?.status;
  if (status !== void 0 && status !== "OK") throw playabilityError(videoId, player.playabilityStatus);
  let formats = formatsOf(player);
  if (context.media === "video" && !hasCombinedVideo(formats)) {
    const combined = await fetchPlayer(context.http, videoId, "androidVr", context.signal).catch(
      () => void 0
    );
    if (combined !== void 0 && combined.playabilityStatus?.status === "OK") {
      formats = [...formatsOf(combined), ...formats];
    }
  }
  const choice = selectFormat(formats, context.media, context.quality);
  const chosen = choice?.format;
  if (chosen?.url === void 0) {
    const ciphered = formats.some((f) => f.signatureCipher !== void 0);
    throw new VectraxError(`No downloadable stream for YouTube video ${videoId}.`, {
      code: "E_NO_MEDIA",
      exitCode: ExitCode.NoResults,
      hint: ciphered ? "YouTube returned only signature-protected streams for this video." : "The video may be a live stream or otherwise unavailable for download.",
      details: { videoId }
    });
  }
  const watchUrl = watchUrlFor(videoId);
  const metadata = buildMetadata(player, watchUrl);
  const extension = extensionFor(chosen);
  const size = Number(chosen.contentLength);
  const duration = Number(player.videoDetails?.lengthSeconds);
  const artworkUrl = bestThumbnail(player);
  const displayTitle = player.videoDetails?.title ?? metadata.title ?? videoId;
  return {
    url: chosen.url,
    title: displayTitle,
    kind: chosen.mimeType?.startsWith("video/") === true ? "video" : "audio",
    extension,
    quality: chosen.qualityLabel ?? (chosen.bitrate !== void 0 ? `${Math.round(chosen.bitrate / 1e3)}kbps` : detectQuality(displayTitle)),
    ...choice?.note !== void 0 ? { note: choice.note } : {},
    source: "direct",
    metadata,
    ...artworkUrl !== void 0 ? { artworkUrl } : {},
    headers: { "user-agent": IOS_USER_AGENT },
    failureHint: "YouTube served part of this file and then refused the rest. Some videos are capped to a short preview for clients that cannot attest themselves, and no amount of retrying or re-requesting lifts the cap. Audio from ordinary uploads is unaffected.",
    fallbackUrl: watchUrl,
    filename: buildFilename2(metadata, displayTitle),
    ...Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {},
    ...Number.isFinite(size) && size > 0 ? { size } : {}
  };
}
function buildFilename2(metadata, fallback) {
  return metadata.artist !== void 0 && metadata.title !== void 0 ? `${metadata.artist} - ${metadata.title}` : metadata.title ?? fallback;
}
async function resolvePlaylist(playlistId, context) {
  const pageUrl = new URL(`https://www.youtube.com/playlist?list=${playlistId}`);
  const { body } = await context.http.text(pageUrl, {
    headers: { "user-agent": BROWSER_USER_AGENT, "accept-language": "en" },
    ...context.signal !== void 0 ? { signal: context.signal } : {}
  });
  const data = parseInitialData(body);
  const entries = extractPlaylistEntries(data);
  if (entries.length === 0) {
    throw new VectraxError(`No videos found in YouTube playlist ${playlistId}.`, {
      code: "E_NO_MEDIA",
      exitCode: ExitCode.NoResults,
      hint: "The playlist may be private, empty, or a personal mix.",
      details: { playlistId }
    });
  }
  const limited = context.limit !== void 0 ? entries.slice(0, context.limit) : entries;
  const warnings = [];
  if (limited.length < entries.length) {
    warnings.push(`Playlist has ${entries.length} videos; taking the first ${limited.length} (--limit).`);
  }
  const settled = await mapPool(
    limited,
    async (entry) => resolveVideo(entry.videoId, context),
    { limit: PLAYLIST_RESOLVE_CONCURRENCY, ...context.signal !== void 0 ? { signal: context.signal } : {} }
  );
  const items = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const position = index + 1;
      items.push({
        ...result.value,
        metadata: {
          ...result.value.metadata,
          album: extractPlaylistTitle(data) ?? result.value.metadata?.album,
          track: position,
          trackTotal: limited.length
        }
      });
    } else {
      const entry = limited[index];
      warnings.push(`Skipped ${entry.title ?? entry.videoId}: ${describe(result.reason)}`);
    }
  });
  if (items.length === 0) {
    throw new VectraxError(`Every video in playlist ${playlistId} was unavailable.`, {
      code: "E_NO_MEDIA",
      exitCode: ExitCode.NoResults,
      details: { playlistId, warnings }
    });
  }
  return {
    pageUrl,
    title: extractPlaylistTitle(data),
    items,
    direct: false,
    warnings
  };
}
function describe(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

// src/core/providers/registry.ts
var providers = [youtubeProvider, unsupportedProvider, pageProvider];
function providerFor(url) {
  return providers.find((provider) => provider.supports(url)) ?? pageProvider;
}
var providerIds = providers.map((provider) => provider.id);

// src/core/scrape/discover.ts
function kindsForIntent(media, configured) {
  if (media === "video") return ["video", "audio"];
  if (media === "audio") return ["audio"];
  return [...configured];
}
async function discoverWithFallback(http, target, options) {
  const first = await discover(http, target, options);
  const widenable = first.items.length === 0 && (options.media ?? "auto") === "auto" && !options.kinds.includes("video");
  if (!widenable) return first;
  const widened = await discover(http, target, { ...options, kinds: [...options.kinds, "video"] });
  if (widened.items.length === 0) return first;
  return {
    ...widened,
    warnings: [...widened.warnings, "No audio found, so Vectrax widened the search to video."]
  };
}
async function discover(http, target, options) {
  const provider = providerFor(target);
  const result = await provider.resolve(target, {
    http,
    kinds: options.kinds,
    extensions: options.extensions,
    match: options.match,
    media: options.media ?? "auto",
    quality: options.quality ?? DEFAULT_QUALITY,
    limit: options.limit,
    signal: options.signal
  });
  const filtered = options.match !== void 0 && provider.id !== "page" ? result.items.filter(
    (item) => options.match?.test(item.title) === true || options.match?.test(item.url) === true
  ) : result.items;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const { kept, collapsed } = provider.id === "page" && !result.direct ? collapseDuplicateQualities(filtered, quality) : { kept: [...filtered], collapsed: 0 };
  const warnings = [...result.warnings ?? []];
  if (collapsed > 0) {
    warnings.push(
      `Collapsed ${collapsed} duplicate ${collapsed === 1 ? "rendition" : "renditions"} of the same items, keeping the ${quality.preset} match.`
    );
  }
  for (const note of new Set(kept.map((item) => item.note).filter((note2) => note2 !== void 0))) {
    warnings.push(note);
  }
  return {
    pageUrl: result.pageUrl,
    pageTitle: result.title,
    items: kept,
    direct: result.direct,
    likelyDynamic: result.likelyDynamic ?? false,
    provider: provider.id,
    warnings
  };
}
function noMediaError(result, kinds) {
  const hint = result.likelyDynamic ? "The page appears to render its content with JavaScript, so the links are not in the HTML. Open the media URL directly and pass that instead." : `Try widening the filter, e.g. --kind ${kinds.includes("audio") ? "audio,video" : "audio"} or --ext mp3,m4a.`;
  return new VectraxError("No matching media found on that page.", {
    code: "E_NO_MEDIA",
    exitCode: ExitCode.NoResults,
    hint,
    details: { url: result.pageUrl.href }
  });
}
async function probeSizes(http, items, options) {
  const settled = await mapPool(
    items,
    async (item) => {
      if (item.size !== void 0) return item.size;
      const probe = await http.probe(item.url, {
        ...item.headers !== void 0 ? { headers: { ...item.headers } } : {},
        ...options.referer !== void 0 ? { referer: options.referer } : {},
        ...options.signal !== void 0 ? { signal: options.signal } : {}
      });
      return probe.size;
    },
    { limit: options.concurrency, ...options.signal !== void 0 ? { signal: options.signal } : {} }
  );
  return items.map((item, index) => {
    const entry = settled[index];
    return { ...item, size: entry?.status === "fulfilled" ? entry.value : void 0 };
  });
}

// src/core/metadata/embed.ts
import path9 from "path";

// src/core/metadata/tags.ts
import { readFile as readFile3, rename as rename3, writeFile as writeFile3, stat as stat2 } from "fs/promises";
import path8 from "path";

// src/core/metadata/flac.ts
var MAGIC = "fLaC";
var BlockType = {
  StreamInfo: 0,
  Padding: 1,
  VorbisComment: 4,
  Picture: 6
};
function isFlac(buffer) {
  return buffer.length >= 4 && buffer.toString("latin1", 0, 4) === MAGIC;
}
function parseBlocks(buffer) {
  const blocks = [];
  let offset = 4;
  while (offset + 4 <= buffer.length) {
    const header = buffer[offset];
    const last = (header & 128) !== 0;
    const type = header & 127;
    const size = buffer.readUIntBE(offset + 1, 3);
    const start = offset + 4;
    const end = start + size;
    if (end > buffer.length) break;
    blocks.push({ type, last, data: buffer.subarray(start, end) });
    offset = end;
    if (last) break;
  }
  return { blocks, audioOffset: offset };
}
function encodeBlock(block, last) {
  const header = Buffer.alloc(4);
  header[0] = (last ? 128 : 0) | block.type & 127;
  header.writeUIntBE(block.data.length, 1, 3);
  return Buffer.concat([header, block.data]);
}
function parseVorbisComments(data) {
  const out = /* @__PURE__ */ new Map();
  if (data.length < 8) return out;
  let offset = 0;
  const vendorLength = data.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > data.length) return out;
  const count = data.readUInt32LE(offset);
  offset += 4;
  for (let i = 0; i < count && offset + 4 <= data.length; i++) {
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (offset + length > data.length) break;
    const entry = data.toString("utf8", offset, offset + length);
    offset += length;
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const key = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1);
    out.set(key, [...out.get(key) ?? [], value]);
  }
  return out;
}
function encodeVorbisComments(fields, vendor = "Vectrax") {
  const vendorBytes = Buffer.from(vendor, "utf8");
  const entries = fields.map(([key, value]) => {
    const bytes = Buffer.from(`${key}=${value}`, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendorBytes.length);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length);
  return Buffer.concat([vendorLength, vendorBytes, count, ...entries]);
}
function parsePicture(data) {
  try {
    let offset = 4;
    const mimeLength = data.readUInt32BE(offset);
    offset += 4;
    const mime = data.toString("latin1", offset, offset + mimeLength);
    offset += mimeLength;
    const descLength = data.readUInt32BE(offset);
    offset += 4;
    const description = data.toString("utf8", offset, offset + descLength);
    offset += descLength;
    offset += 16;
    const dataLength = data.readUInt32BE(offset);
    offset += 4;
    const payload = data.subarray(offset, offset + dataLength);
    return payload.length > 0 ? { mime, data: Buffer.from(payload), description: description === "" ? void 0 : description } : void 0;
  } catch {
    return void 0;
  }
}
function encodePicture(artwork) {
  const mime = Buffer.from(artwork.mime, "latin1");
  const description = Buffer.from(artwork.description ?? "", "utf8");
  const dimensions = imageDimensions(artwork.data);
  const buffer = Buffer.alloc(32 + mime.length + description.length + artwork.data.length);
  let offset = 0;
  const u32 = (value) => {
    buffer.writeUInt32BE(value, offset);
    offset += 4;
  };
  u32(3);
  u32(mime.length);
  mime.copy(buffer, offset);
  offset += mime.length;
  u32(description.length);
  description.copy(buffer, offset);
  offset += description.length;
  u32(dimensions?.width ?? 0);
  u32(dimensions?.height ?? 0);
  u32(24);
  u32(0);
  u32(artwork.data.length);
  artwork.data.copy(buffer, offset);
  return buffer;
}
function imageDimensions(data) {
  if (data.length > 24 && data.readUInt32BE(0) === 2303741511) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length > 4 && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 255) {
        offset++;
        continue;
      }
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return void 0;
}
var TEXT_KEYS = [
  ["title", "TITLE"],
  ["artist", "ARTIST"],
  ["album", "ALBUM"],
  ["albumArtist", "ALBUMARTIST"],
  ["genre", "GENRE"],
  ["composer", "COMPOSER"],
  ["comment", "COMMENT"],
  ["sourceUrl", "SOURCEURL"]
];
var NUMERIC_KEYS = [
  ["track", "TRACKNUMBER"],
  ["trackTotal", "TRACKTOTAL"],
  ["disc", "DISCNUMBER"],
  ["discTotal", "DISCTOTAL"]
];
function readFlac(buffer) {
  if (!isFlac(buffer)) return {};
  const { blocks } = parseBlocks(buffer);
  const metadata = {};
  for (const block of blocks) {
    if (block.type === BlockType.VorbisComment) {
      const comments = parseVorbisComments(block.data);
      const first = (key) => comments.get(key)?.[0];
      for (const [field, key] of TEXT_KEYS) {
        const value = first(key);
        if (value !== void 0 && value !== "") Object.assign(metadata, { [field]: value });
      }
      for (const [field, key] of NUMERIC_KEYS) {
        const raw = first(key);
        const value = Number.parseInt(raw?.split("/")[0] ?? "", 10);
        if (Number.isFinite(value) && value > 0) Object.assign(metadata, { [field]: value });
      }
      const pair = first("TRACKNUMBER")?.split("/")[1];
      if (metadata.trackTotal === void 0 && pair !== void 0) {
        const total = Number.parseInt(pair, 10);
        if (Number.isFinite(total) && total > 0) metadata.trackTotal = total;
      }
      const year = Number.parseInt((first("DATE") ?? first("YEAR") ?? "").slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
    } else if (block.type === BlockType.Picture && metadata.artwork === void 0) {
      const artwork = parsePicture(block.data);
      if (artwork !== void 0) metadata.artwork = artwork;
    }
  }
  return metadata;
}
function writeFlac(buffer, metadata) {
  if (!isFlac(buffer)) return buffer;
  const { blocks, audioOffset } = parseBlocks(buffer);
  const fields = [];
  for (const [field, key] of TEXT_KEYS) {
    const value = metadata[field];
    if (typeof value === "string" && value !== "") fields.push([key, value]);
  }
  for (const [field, key] of NUMERIC_KEYS) {
    const value = metadata[field];
    if (typeof value === "number") fields.push([key, String(value)]);
  }
  if (metadata.year !== void 0) fields.push(["DATE", String(metadata.year)]);
  const preserved = blocks.filter(
    (block) => block.type !== BlockType.VorbisComment && block.type !== BlockType.Picture && block.type !== BlockType.Padding
  );
  const rebuilt = [
    ...preserved,
    { type: BlockType.VorbisComment, last: false, data: encodeVorbisComments(fields) }
  ];
  if (metadata.artwork !== void 0) {
    rebuilt.push({ type: BlockType.Picture, last: false, data: encodePicture(metadata.artwork) });
  }
  const encoded = rebuilt.map((block, index) => encodeBlock(block, index === rebuilt.length - 1));
  return Buffer.concat([Buffer.from(MAGIC, "latin1"), ...encoded, buffer.subarray(audioOffset)]);
}

// src/core/metadata/id3.ts
var HEADER_SIZE = 10;
function readSynchsafe(buffer, offset) {
  return (buffer[offset] & 127) * 2097152 + (buffer[offset + 1] & 127) * 16384 + (buffer[offset + 2] & 127) * 128 + (buffer[offset + 3] & 127);
}
function writeSynchsafe(value) {
  return Buffer.from([
    value >>> 21 & 127,
    value >>> 14 & 127,
    value >>> 7 & 127,
    value & 127
  ]);
}
function findId3Tag(buffer) {
  if (buffer.length < HEADER_SIZE) return void 0;
  if (buffer.toString("latin1", 0, 3) !== "ID3") return void 0;
  const version = buffer[3];
  const flags = buffer[5];
  const size = readSynchsafe(buffer, 6);
  const footer = (flags & 16) !== 0 ? 10 : 0;
  return { start: 0, end: HEADER_SIZE + size + footer, version };
}
function stripId3(buffer) {
  const tag = findId3Tag(buffer);
  let audio = tag !== void 0 ? buffer.subarray(tag.end) : buffer;
  if (audio.length >= 128 && audio.toString("latin1", audio.length - 128, audio.length - 125) === "TAG") {
    audio = audio.subarray(0, audio.length - 128);
  }
  return audio;
}
function deunsynchronise(buffer) {
  const out = [];
  for (let i = 0; i < buffer.length; i++) {
    out.push(buffer[i]);
    if (buffer[i] === 255 && buffer[i + 1] === 0) i++;
  }
  return Buffer.from(out);
}
function decodeText(buffer) {
  if (buffer.length === 0) return "";
  const encoding = buffer[0];
  const body = buffer.subarray(1);
  switch (encoding) {
    case 0:
      return trimNull(body.toString("latin1"));
    case 1:
      return trimNull(decodeUtf16WithBom(body));
    case 2:
      return trimNull(body.swap16().toString("utf16le"));
    default:
      return trimNull(body.toString("utf8"));
  }
}
function decodeUtf16WithBom(buffer) {
  if (buffer.length < 2) return "";
  const bom = buffer.readUInt16LE(0);
  if (bom === 65279) return buffer.subarray(2).toString("utf16le");
  if (bom === 65534) return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  return buffer.toString("utf16le");
}
var trimNull = (value) => value.replace(/\u0000+$/, "").trim();
var FRAMES_V22 = {
  TT2: "TIT2",
  TP1: "TPE1",
  TAL: "TALB",
  TP2: "TPE2",
  TCO: "TCON",
  TYE: "TDRC",
  TRK: "TRCK",
  TPA: "TPOS",
  COM: "COMM",
  PIC: "APIC",
  TCM: "TCOM"
};
function readId3(buffer) {
  const tag = findId3Tag(buffer);
  if (tag === void 0) return {};
  const major = buffer[3];
  const flags = buffer[5];
  let body = buffer.subarray(HEADER_SIZE, tag.end);
  if ((flags & 128) !== 0) body = deunsynchronise(body);
  let offset = 0;
  if ((flags & 64) !== 0 && body.length >= 4) {
    offset += major >= 4 ? readSynchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }
  const metadata = {};
  const idLength = major <= 2 ? 3 : 4;
  const sizeLength = major <= 2 ? 3 : 4;
  while (offset + idLength + sizeLength <= body.length) {
    const rawId = body.toString("latin1", offset, offset + idLength);
    if (!/^[A-Z0-9]{3,4}$/.test(rawId)) break;
    let size;
    if (major <= 2) size = body.readUIntBE(offset + 3, 3);
    else if (major === 3) size = body.readUInt32BE(offset + 4);
    else size = readSynchsafe(body, offset + 4);
    const headerLength = idLength + sizeLength + (major <= 2 ? 0 : 2);
    const start = offset + headerLength;
    const end = start + size;
    if (size <= 0 || end > body.length) break;
    const id = major <= 2 ? FRAMES_V22[rawId] ?? rawId : rawId;
    applyFrame(metadata, id, body.subarray(start, end));
    offset = end;
  }
  return metadata;
}
function applyFrame(metadata, id, data) {
  switch (id) {
    case "TIT2":
      metadata.title = decodeText(data);
      return;
    case "TPE1":
      metadata.artist = decodeText(data);
      return;
    case "TALB":
      metadata.album = decodeText(data);
      return;
    case "TPE2":
      metadata.albumArtist = decodeText(data);
      return;
    case "TCON":
      metadata.genre = normaliseGenre(decodeText(data));
      return;
    case "TCOM":
      metadata.composer = decodeText(data);
      return;
    case "TDRC":
    case "TYER":
    case "TDAT": {
      const year = Number.parseInt(decodeText(data).slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
      return;
    }
    case "TRCK": {
      const [track, total] = splitPair(decodeText(data));
      if (track !== void 0) metadata.track = track;
      if (total !== void 0) metadata.trackTotal = total;
      return;
    }
    case "TPOS": {
      const [disc, total] = splitPair(decodeText(data));
      if (disc !== void 0) metadata.disc = disc;
      if (total !== void 0) metadata.discTotal = total;
      return;
    }
    case "COMM": {
      if (data.length < 5) return;
      const encoding = data[0];
      const rest = data.subarray(4);
      const separator = encoding === 1 || encoding === 2 ? findDoubleNull(rest) : rest.indexOf(0);
      const textStart = separator === -1 ? 0 : separator + (encoding === 1 || encoding === 2 ? 2 : 1);
      metadata.comment = decodeText(Buffer.concat([Buffer.from([encoding]), rest.subarray(textStart)]));
      return;
    }
    case "WXXX":
    case "WOAF": {
      const url = trimNull(data.subarray(data.indexOf(0) + 1).toString("latin1"));
      if (url !== "" && metadata.sourceUrl === void 0) metadata.sourceUrl = url;
      return;
    }
    case "APIC": {
      const artwork = readApic(data);
      if (artwork !== void 0) metadata.artwork = artwork;
      return;
    }
    default:
      return;
  }
}
function readApic(data) {
  if (data.length < 4) return void 0;
  const encoding = data[0];
  const mimeEnd = data.indexOf(0, 1);
  if (mimeEnd === -1) return void 0;
  let mime = data.toString("latin1", 1, mimeEnd);
  if (mime.length <= 4 && !mime.includes("/")) mime = `image/${mime.toLowerCase() === "png" ? "png" : "jpeg"}`;
  let cursor = mimeEnd + 2;
  const wide = encoding === 1 || encoding === 2;
  const descEnd = wide ? findDoubleNull(data.subarray(cursor)) : data.subarray(cursor).indexOf(0);
  if (descEnd === -1) return void 0;
  cursor += descEnd + (wide ? 2 : 1);
  const payload = data.subarray(cursor);
  return payload.length > 0 ? { mime, data: Buffer.from(payload) } : void 0;
}
function findDoubleNull(buffer) {
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) return i;
  }
  return -1;
}
function splitPair(value) {
  const [first, second] = value.split("/");
  const toNumber = (v) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : void 0;
  };
  return [toNumber(first), toNumber(second)];
}
var ID3V1_GENRES = [
  "Blues",
  "Classic Rock",
  "Country",
  "Dance",
  "Disco",
  "Funk",
  "Grunge",
  "Hip-Hop",
  "Jazz",
  "Metal",
  "New Age",
  "Oldies",
  "Other",
  "Pop",
  "R&B",
  "Rap",
  "Reggae",
  "Rock",
  "Techno",
  "Industrial",
  "Alternative",
  "Ska",
  "Death Metal",
  "Pranks",
  "Soundtrack",
  "Euro-Techno",
  "Ambient",
  "Trip-Hop",
  "Vocal",
  "Jazz+Funk",
  "Fusion",
  "Trance",
  "Classical",
  "Instrumental",
  "Acid",
  "House",
  "Game",
  "Sound Clip",
  "Gospel",
  "Noise",
  "AlternRock",
  "Bass",
  "Soul",
  "Punk",
  "Space",
  "Meditative"
];
function normaliseGenre(value) {
  const numeric = /^\((\d+)\)$/.exec(value.trim());
  if (numeric?.[1] !== void 0) return ID3V1_GENRES[Number(numeric[1])] ?? value;
  if (/^\d+$/.test(value.trim())) return ID3V1_GENRES[Number(value.trim())] ?? value;
  return value;
}
function textFrame(id, value) {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
  return frame(id, payload);
}
function frame(id, payload) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, "latin1");
  writeSynchsafe(payload.length).copy(header, 4);
  return Buffer.concat([header, payload]);
}
function commentFrame(value) {
  return frame(
    "COMM",
    Buffer.concat([
      Buffer.from([3]),
      Buffer.from("eng", "latin1"),
      Buffer.from([0]),
      Buffer.from(value, "utf8")
    ])
  );
}
function apicFrame(artwork) {
  return frame(
    "APIC",
    Buffer.concat([
      Buffer.from([3]),
      Buffer.from(artwork.mime, "latin1"),
      Buffer.from([0]),
      Buffer.from([3]),
      Buffer.from(artwork.description ?? "", "utf8"),
      Buffer.from([0]),
      artwork.data
    ])
  );
}
function writeId3(buffer, metadata) {
  const frames = [];
  if (metadata.title !== void 0) frames.push(textFrame("TIT2", metadata.title));
  if (metadata.artist !== void 0) frames.push(textFrame("TPE1", metadata.artist));
  if (metadata.album !== void 0) frames.push(textFrame("TALB", metadata.album));
  if (metadata.albumArtist !== void 0) frames.push(textFrame("TPE2", metadata.albumArtist));
  if (metadata.genre !== void 0) frames.push(textFrame("TCON", metadata.genre));
  if (metadata.composer !== void 0) frames.push(textFrame("TCOM", metadata.composer));
  if (metadata.year !== void 0) frames.push(textFrame("TDRC", String(metadata.year)));
  if (metadata.track !== void 0) {
    frames.push(
      textFrame("TRCK", metadata.trackTotal !== void 0 ? `${metadata.track}/${metadata.trackTotal}` : String(metadata.track))
    );
  }
  if (metadata.disc !== void 0) {
    frames.push(
      textFrame("TPOS", metadata.discTotal !== void 0 ? `${metadata.disc}/${metadata.discTotal}` : String(metadata.disc))
    );
  }
  if (metadata.comment !== void 0) frames.push(commentFrame(metadata.comment));
  if (metadata.sourceUrl !== void 0) {
    frames.push(frame("WXXX", Buffer.concat([Buffer.from([3]), Buffer.from([0]), Buffer.from(metadata.sourceUrl, "latin1")])));
  }
  if (metadata.artwork !== void 0) frames.push(apicFrame(metadata.artwork));
  const audio = stripId3(buffer);
  if (frames.length === 0) return audio;
  const body = Buffer.concat(frames);
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("ID3", 0, 3, "latin1");
  header[3] = 4;
  header[4] = 0;
  header[5] = 0;
  writeSynchsafe(body.length).copy(header, 6);
  return Buffer.concat([header, body, audio]);
}

// src/core/metadata/mp4.ts
var CONTAINERS = /* @__PURE__ */ new Set(["moov", "udta", "trak", "mdia", "minf", "stbl", "ilst"]);
var DataType = { Implicit: 0, Utf8: 1, Jpeg: 13, Png: 14, SignedInt: 21 };
function isMp4(buffer) {
  return buffer.length > 12 && buffer.toString("latin1", 4, 8) === "ftyp";
}
function parseAtoms(buffer, start, end) {
  const atoms = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let dataStart = offset + 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      dataStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) break;
    atoms.push({ type, start: offset, dataStart, end: offset + size });
    offset += size;
  }
  return atoms;
}
function findAtom(atoms, type) {
  return atoms.find((atom2) => atom2.type === type);
}
function metaChildrenOffset(buffer, meta) {
  if (meta.dataStart + 8 > meta.end) return meta.dataStart;
  const typeAtZero = buffer.toString("latin1", meta.dataStart + 4, meta.dataStart + 8);
  return /^[a-zA-Z0-9©\-. ]{4}$/.test(typeAtZero) ? meta.dataStart : meta.dataStart + 4;
}
function locateTagAtoms(buffer) {
  const top = parseAtoms(buffer, 0, buffer.length);
  const moov = findAtom(top, "moov");
  if (moov === void 0) return void 0;
  const udta = findAtom(parseAtoms(buffer, moov.dataStart, moov.end), "udta");
  if (udta === void 0) return { moov };
  const meta = findAtom(parseAtoms(buffer, udta.dataStart, udta.end), "meta");
  if (meta === void 0) return { moov, udta };
  const ilst = findAtom(parseAtoms(buffer, metaChildrenOffset(buffer, meta), meta.end), "ilst");
  return ilst === void 0 ? { moov, udta, meta } : { moov, udta, meta, ilst };
}
function readMp4(buffer) {
  if (!isMp4(buffer)) return {};
  const located = locateTagAtoms(buffer);
  if (located?.ilst === void 0) return {};
  const metadata = {};
  for (const item of parseAtoms(buffer, located.ilst.dataStart, located.ilst.end)) {
    const data = findAtom(parseAtoms(buffer, item.dataStart, item.end), "data");
    if (data === void 0 || data.dataStart + 8 > data.end) continue;
    const indicator = buffer.readUInt32BE(data.dataStart) & 16777215;
    const payload = buffer.subarray(data.dataStart + 8, data.end);
    applyItem(metadata, item.type, indicator, payload);
  }
  return metadata;
}
function applyItem(metadata, type, indicator, payload) {
  const text2 = () => payload.toString("utf8").replace(/\u0000+$/, "");
  switch (type) {
    case "\xA9nam":
      metadata.title = text2();
      return;
    case "\xA9ART":
      metadata.artist = text2();
      return;
    case "\xA9alb":
      metadata.album = text2();
      return;
    case "aART":
      metadata.albumArtist = text2();
      return;
    case "\xA9gen":
      metadata.genre = text2();
      return;
    case "\xA9wrt":
      metadata.composer = text2();
      return;
    case "\xA9cmt":
      metadata.comment = text2();
      return;
    case "\xA9day": {
      const year = Number.parseInt(text2().slice(0, 4), 10);
      if (Number.isFinite(year) && year > 0) metadata.year = year;
      return;
    }
    case "trkn": {
      if (payload.length >= 6) {
        const track = payload.readUInt16BE(2);
        const total = payload.readUInt16BE(4);
        if (track > 0) metadata.track = track;
        if (total > 0) metadata.trackTotal = total;
      }
      return;
    }
    case "disk": {
      if (payload.length >= 6) {
        const disc = payload.readUInt16BE(2);
        const total = payload.readUInt16BE(4);
        if (disc > 0) metadata.disc = disc;
        if (total > 0) metadata.discTotal = total;
      }
      return;
    }
    case "covr": {
      if (payload.length > 0) {
        metadata.artwork = {
          mime: indicator === DataType.Png ? "image/png" : "image/jpeg",
          data: Buffer.from(payload)
        };
      }
      return;
    }
    default:
      return;
  }
}
function atom(type, ...payload) {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, body]);
}
function dataBox(indicator, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(indicator, 0);
  head.writeUInt32BE(0, 4);
  return atom("data", head, payload);
}
var textItem = (type, value) => atom(type, dataBox(DataType.Utf8, Buffer.from(value, "utf8")));
function pairItem(type, value, total, width) {
  const payload = Buffer.alloc(width);
  payload.writeUInt16BE(value, 2);
  payload.writeUInt16BE(total ?? 0, 4);
  return atom(type, dataBox(DataType.Implicit, payload));
}
function buildIlst(metadata) {
  const items = [];
  if (metadata.title !== void 0) items.push(textItem("\xA9nam", metadata.title));
  if (metadata.artist !== void 0) items.push(textItem("\xA9ART", metadata.artist));
  if (metadata.album !== void 0) items.push(textItem("\xA9alb", metadata.album));
  if (metadata.albumArtist !== void 0) items.push(textItem("aART", metadata.albumArtist));
  if (metadata.genre !== void 0) items.push(textItem("\xA9gen", metadata.genre));
  if (metadata.composer !== void 0) items.push(textItem("\xA9wrt", metadata.composer));
  if (metadata.year !== void 0) items.push(textItem("\xA9day", String(metadata.year)));
  const comment = [metadata.comment, metadata.sourceUrl].filter((v) => v !== void 0 && v !== "").join("\n");
  if (comment !== "") items.push(textItem("\xA9cmt", comment));
  if (metadata.track !== void 0) items.push(pairItem("trkn", metadata.track, metadata.trackTotal, 8));
  if (metadata.disc !== void 0) items.push(pairItem("disk", metadata.disc, metadata.discTotal, 6));
  if (metadata.artwork !== void 0) {
    const indicator = metadata.artwork.mime.includes("png") ? DataType.Png : DataType.Jpeg;
    items.push(atom("covr", dataBox(indicator, metadata.artwork.data)));
  }
  return atom("ilst", ...items);
}
function buildMetaHandler() {
  return atom(
    "hdlr",
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from("mdir", "latin1"),
    Buffer.from("appl", "latin1"),
    Buffer.alloc(9)
  );
}
function buildUdta(metadata, preserved) {
  const meta = atom(
    "meta",
    Buffer.alloc(4),
    buildMetaHandler(),
    buildIlst(metadata)
  );
  return atom("udta", ...preserved, meta);
}
function patchChunkOffsets(moov, delta) {
  if (delta === 0) return;
  const walk = (start, end) => {
    for (const child of parseAtoms(moov, start, end)) {
      if (child.type === "stco") {
        const count = moov.readUInt32BE(child.dataStart + 4);
        for (let i = 0; i < count; i++) {
          const at = child.dataStart + 8 + i * 4;
          if (at + 4 > child.end) break;
          moov.writeUInt32BE(moov.readUInt32BE(at) + delta, at);
        }
      } else if (child.type === "co64") {
        const count = moov.readUInt32BE(child.dataStart + 4);
        for (let i = 0; i < count; i++) {
          const at = child.dataStart + 8 + i * 8;
          if (at + 8 > child.end) break;
          moov.writeBigUInt64BE(moov.readBigUInt64BE(at) + BigInt(delta), at);
        }
      } else if (CONTAINERS.has(child.type)) {
        walk(child.dataStart, child.end);
      }
    }
  };
  walk(8, moov.length);
}
function writeMp4(buffer, metadata) {
  if (!isMp4(buffer)) return buffer;
  const located = locateTagAtoms(buffer);
  if (located === void 0) return buffer;
  const { moov, udta } = located;
  const preserved = udta !== void 0 ? parseAtoms(buffer, udta.dataStart, udta.end).filter((child) => child.type !== "meta").map((child) => Buffer.from(buffer.subarray(child.start, child.end))) : [];
  const newUdta = buildUdta(metadata, preserved);
  const oldUdtaStart = udta?.start ?? moov.end;
  const oldUdtaEnd = udta?.end ?? moov.end;
  const moovPayload = Buffer.concat([
    buffer.subarray(moov.dataStart, oldUdtaStart),
    newUdta,
    buffer.subarray(oldUdtaEnd, moov.end)
  ]);
  const newMoov = atom("moov", moovPayload);
  const delta = newMoov.length - (moov.end - moov.start);
  const mdat = findAtom(parseAtoms(buffer, 0, buffer.length), "mdat");
  if (mdat !== void 0 && moov.start < mdat.start) patchChunkOffsets(newMoov, delta);
  return Buffer.concat([buffer.subarray(0, moov.start), newMoov, buffer.subarray(moov.end)]);
}

// src/core/metadata/tags.ts
var EXTENSION_FORMATS = {
  ".mp3": "id3",
  ".flac": "flac",
  ".m4a": "mp4",
  ".mp4": "mp4",
  ".m4b": "mp4",
  ".m4v": "mp4",
  ".aac": "id3"
};
function supportsTagging(filename) {
  return path8.extname(filename).toLowerCase() in EXTENSION_FORMATS;
}
function detectFormat(buffer, filename) {
  if (isFlac(buffer)) return "flac";
  if (isMp4(buffer)) return "mp4";
  if (findId3Tag(buffer) !== void 0) return "id3";
  if (buffer.length > 2 && buffer[0] === 255 && (buffer[1] & 224) === 224) return "id3";
  return EXTENSION_FORMATS[path8.extname(filename).toLowerCase()];
}
function readTagsFromBuffer(buffer, filename) {
  switch (detectFormat(buffer, filename)) {
    case "flac":
      return readFlac(buffer);
    case "mp4":
      return readMp4(buffer);
    case "id3":
      return readId3(buffer);
    default:
      return {};
  }
}
function writeTagsToBuffer(buffer, filename, metadata) {
  switch (detectFormat(buffer, filename)) {
    case "flac":
      return writeFlac(buffer, metadata);
    case "mp4":
      return writeMp4(buffer, metadata);
    case "id3":
      return writeId3(buffer, metadata);
    default:
      throw new VectraxError(`Cannot tag ${path8.basename(filename)}: unrecognised audio container.`, {
        code: "E_USAGE",
        hint: `Supported formats: ${[...new Set(Object.keys(EXTENSION_FORMATS))].join(", ")}.`
      });
  }
}
var MAX_TAG_FILE_BYTES = 512 * 1024 * 1024;
async function readTags(file) {
  let buffer;
  try {
    buffer = await readFile3(file);
  } catch (error) {
    throw wrapFsError(error, "read file", file);
  }
  return readTagsFromBuffer(buffer, file);
}
async function writeTags(file, metadata) {
  const info = await stat2(file).catch((error) => {
    throw wrapFsError(error, "stat file", file);
  });
  if (info.size > MAX_TAG_FILE_BYTES) {
    throw new FilesystemError(`Refusing to tag ${path8.basename(file)}: file is larger than 512 MB.`, {
      hint: "Tagging rewrites the container in memory."
    });
  }
  const buffer = await readFile3(file).catch((error) => {
    throw wrapFsError(error, "read file", file);
  });
  const updated = writeTagsToBuffer(buffer, file, metadata);
  const staging = `${file}.vxtag`;
  try {
    await writeFile3(staging, updated);
    await rename3(staging, file);
  } catch (error) {
    await removeQuietly(staging);
    throw wrapFsError(error, "write tags to", file);
  }
}
function detectImageMime(data) {
  if (data.length > 8 && data.readUInt32BE(0) === 2303741511) return "image/png";
  if (data.length > 3 && data[0] === 255 && data[1] === 216) return "image/jpeg";
  if (data.length > 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (data.length > 6 && data.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return void 0;
}
function toArtwork(data, description) {
  const mime = detectImageMime(data);
  if (mime === void 0) {
    throw new VectraxError("That file is not a recognised image (expected PNG, JPEG, WebP, or GIF).", {
      code: "E_USAGE"
    });
  }
  return { mime, data, ...description !== void 0 ? { description } : {} };
}
function artworkExtension(artwork) {
  return artwork.mime.includes("png") ? ".png" : artwork.mime.includes("webp") ? ".webp" : artwork.mime.includes("gif") ? ".gif" : ".jpg";
}
async function readArtworkFile(file) {
  try {
    return toArtwork(await readFile3(file), path8.basename(file));
  } catch (error) {
    if (error instanceof VectraxError) throw error;
    throw new FilesystemError(`Cannot read artwork file: ${file} (${errorMessage(error)})`, { cause: error });
  }
}

// src/core/metadata/embed.ts
var ArtworkCache = class {
  constructor(http, maxBytes, signal) {
    this.http = http;
    this.maxBytes = maxBytes;
    this.signal = signal;
  }
  http;
  maxBytes;
  signal;
  entries = /* @__PURE__ */ new Map();
  get(url) {
    const existing = this.entries.get(url);
    if (existing !== void 0) return existing;
    const pending = this.fetch(url);
    this.entries.set(url, pending);
    return pending;
  }
  async fetch(url) {
    try {
      const { data } = await this.http.buffer(url, {
        maxBytes: this.maxBytes,
        ...this.signal !== void 0 ? { signal: this.signal } : {}
      });
      return toArtwork(data);
    } catch {
      return void 0;
    }
  }
};
async function applyMetadata(http, jobs, options = {}) {
  const taggable = jobs.filter((job) => supportsTagging(job.path));
  const skipped = jobs.length - taggable.length;
  if (taggable.length === 0) return { tagged: 0, skipped, warnings: [] };
  const cache = new ArtworkCache(http, options.maxArtworkBytes ?? 8 * 1024 * 1024, options.signal);
  const warnings = [];
  const settled = await mapPool(
    taggable,
    async (job) => {
      let metadata = job.metadata;
      if (options.artwork !== false && job.artworkUrl !== void 0) {
        const artwork = await cache.get(job.artworkUrl);
        if (artwork !== void 0) metadata = { ...metadata, artwork };
      }
      const existing = await readTags(job.path).catch(() => ({}));
      await writeTags(job.path, mergeMetadata(existing, metadata));
    },
    {
      limit: Math.max(1, options.concurrency ?? 4),
      ...options.signal !== void 0 ? { signal: options.signal } : {}
    }
  );
  let tagged = 0;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") tagged++;
    else {
      const job = taggable[index];
      warnings.push(`${path9.basename(job.path)}: ${errorMessage(result.reason)}`);
    }
  });
  return { tagged, skipped, warnings };
}

// src/core/fallback/ytdlp.ts
import { spawn } from "child_process";
import path10 from "path";
import { access as access3, constants as constants3 } from "fs/promises";
var BINARIES = ["yt-dlp", "yt-dlp_linux", "yt-dlp_macos", "youtube-dl"];
var VERSION_TIMEOUT_MS = 5e3;
var DEFAULT_TIMEOUT_MS = 30 * 6e4;
var cached;
function probeVersion(binary) {
  return new Promise((resolve2) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve2(void 0);
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve2(void 0);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve2(code === 0 && out.trim() !== "" ? out.trim().split("\n")[0] : void 0);
    });
  });
}
async function locateTool(binary) {
  const managed = path10.join(toolsDirectory(), isWindows() ? `${binary}.exe` : binary);
  try {
    await access3(managed, isWindows() ? constants3.F_OK : constants3.X_OK);
    return managed;
  } catch {
  }
  return findExecutable(binary);
}
async function detectFallbackTool() {
  if (cached !== void 0) return cached ?? void 0;
  for (const binary of BINARIES) {
    const resolved = await locateTool(binary);
    if (resolved === void 0) continue;
    const version = await probeVersion(resolved);
    if (version !== void 0) {
      cached = { binary: resolved, version };
      return cached;
    }
  }
  cached = null;
  return void 0;
}
function resetFallbackCache() {
  cached = void 0;
}
function formatSelector(media, quality, permissive = false) {
  if (media === "video") {
    if (permissive) return ["-f", "bv*+ba/b"];
    const height = quality.videoHeight;
    const cap = height === MAX ? "" : `[height<=${height}]`;
    return [
      "-f",
      `bv*${cap}+ba/b${cap}/bv*+ba/b`,
      "-S",
      height === MAX ? "res,vcodec:h264" : `res:${height},vcodec:h264`
    ];
  }
  if (permissive) return ["-f", "bestaudio/best"];
  const kbps = quality.audioKbps;
  return [
    "-f",
    "bestaudio[ext=m4a]/bestaudio/best",
    "-S",
    kbps === MAX ? "aext:m4a,abr" : `abr~${kbps},aext:m4a`
  ];
}
function outputTemplate(outputDir, filename) {
  const stem = sanitizeFilename(filename, "download").replace(/%/g, "");
  return path10.join(outputDir, `${stem}.%(ext)s`);
}
var PROGRESS = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;
async function runFallback(tool, request) {
  try {
    return await attemptFallback(tool, request, false);
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted === true) throw error;
    request.onRetry?.();
    return attemptFallback(tool, request, true);
  }
}
async function attemptFallback(tool, request, permissive) {
  const args = [
    ...formatSelector(request.media, request.quality, permissive),
    "--retries",
    "3",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--no-simulate",
    "--print",
    "after_move:filepath",
    "--no-part",
    "-o",
    outputTemplate(request.outputDir, request.filename),
    request.url
  ];
  return new Promise((resolve2, reject) => {
    const child = spawn(tool.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        () => reject(
          new VectraxError(`${path10.basename(tool.binary)} timed out.`, {
            code: "E_TIMEOUT",
            exitCode: ExitCode.NetworkError
          })
        )
      );
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(request.signal?.reason ?? new Error("Aborted")));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text2 = chunk.toString("utf8");
      stderr += text2;
      pending += text2;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      let latest;
      for (const line of lines) {
        const match = PROGRESS.exec(line);
        if (match?.[1] !== void 0) latest = Number(match[1]) / 100;
      }
      if (latest !== void 0) request.onProgress?.(latest);
    });
    child.on("error", (error) => {
      finish(
        () => reject(
          new VectraxError(`Could not run ${path10.basename(tool.binary)}: ${error.message}`, {
            code: "E_INTERNAL",
            exitCode: ExitCode.Failure
          })
        )
      );
    });
    child.on("close", (code) => {
      finish(() => {
        const produced = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "" && path10.isAbsolute(line));
        const file = produced[produced.length - 1];
        if (code !== 0 || file === void 0) {
          reject(
            new VectraxError(
              `${path10.basename(tool.binary)} could not download this item.`,
              {
                code: "E_NO_MEDIA",
                exitCode: ExitCode.NoResults,
                hint: firstUsefulLine(stderr),
                details: { exitCode: code }
              }
            )
          );
          return;
        }
        resolve2({ path: file, tool });
      });
    });
  });
}
function firstUsefulLine(stderr) {
  const line = stderr.split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith("ERROR:") || entry.startsWith("WARNING:"));
  return line === void 0 ? void 0 : line.replace(/^(ERROR|WARNING):\s*/, "");
}

// src/core/fallback/install.ts
import { spawn as spawn2 } from "child_process";
import { chmod, rename as rename4, writeFile as writeFile4 } from "fs/promises";
import { createHash } from "crypto";
import path11 from "path";
var RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
var CHECKSUMS = `${RELEASE_BASE}/SHA2-256SUMS`;
var INSTALL_TIMEOUT_MS = 10 * 6e4;
var MAX_BINARY_BYTES = 64 * 1024 * 1024;
var MANAGERS = [
  {
    id: "pipx",
    binary: "pipx",
    args: ["install", "yt-dlp"],
    platforms: ["linux", "macos", "windows"],
    describe: () => "pipx install yt-dlp"
  },
  {
    id: "winget",
    binary: "winget",
    args: ["install", "--id", "yt-dlp.yt-dlp", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"],
    platforms: ["windows"],
    describe: () => "winget install yt-dlp.yt-dlp"
  },
  {
    id: "scoop",
    binary: "scoop",
    args: ["install", "yt-dlp"],
    platforms: ["windows"],
    describe: () => "scoop install yt-dlp"
  },
  {
    id: "brew",
    binary: "brew",
    args: ["install", "yt-dlp"],
    platforms: ["macos", "linux"],
    describe: () => "brew install yt-dlp"
  }
];
function standaloneAsset() {
  const arch = architecture();
  switch (platform()) {
    case "windows":
      return arch === "x64" || arch === "ia32" ? "yt-dlp.exe" : void 0;
    case "macos":
      return "yt-dlp_macos";
    case "linux":
      if (arch === "x64") return "yt-dlp_linux";
      if (arch === "arm64") return "yt-dlp_linux_aarch64";
      if (arch === "arm") return "yt-dlp_linux_armv7l";
      return void 0;
    default:
      return void 0;
  }
}
function manualInstruction() {
  switch (platform()) {
    case "windows":
      return "winget install yt-dlp.yt-dlp";
    case "macos":
      return "brew install yt-dlp";
    default:
      return "pipx install yt-dlp";
  }
}
async function planInstall() {
  const current = platform();
  for (const manager of MANAGERS) {
    if (!manager.platforms.includes(current)) continue;
    const binary = await findExecutable(manager.binary);
    if (binary === void 0) continue;
    return {
      kind: "manager",
      id: manager.id,
      command: binary,
      args: manager.args,
      description: manager.describe(binary),
      manual: manager.describe(binary)
    };
  }
  const asset = standaloneAsset();
  if (asset === void 0) return void 0;
  const destination = path11.join(toolsDirectory(), isWindows() ? "yt-dlp.exe" : "yt-dlp");
  return {
    kind: "download",
    id: "standalone",
    asset,
    url: `${RELEASE_BASE}/${asset}`,
    checksumUrl: CHECKSUMS,
    destination,
    description: `download the official yt-dlp binary to ${destination}`,
    manual: manualInstruction()
  };
}
function runCommand(command, args, signal, onOutput) {
  return new Promise((resolve2, reject) => {
    const child = spawn2(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new VectraxError("The installer timed out.", { code: "E_TIMEOUT" })));
    }, INSTALL_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason ?? new Error("Aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const forward = (chunk) => {
      const text2 = chunk.toString("utf8");
      for (const line of text2.split(/\r?\n/)) {
        if (line.trim() !== "") onOutput?.(line.trim());
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      forward(chunk);
    });
    child.on("error", (error) => {
      finish(
        () => reject(new VectraxError(`Could not run ${path11.basename(command)}: ${error.message}`))
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve2();
        else
          reject(
            new VectraxError(`${path11.basename(command)} exited with code ${code}.`, {
              hint: lastMeaningfulLine(stderr)
            })
          );
      });
    });
  });
}
function lastMeaningfulLine(text2) {
  const lines = text2.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  return lines[lines.length - 1];
}
function parseChecksums(body) {
  const out = /* @__PURE__ */ new Map();
  for (const line of body.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match?.[1] !== void 0 && match[2] !== void 0) {
      out.set(match[2], match[1].toLowerCase());
    }
  }
  return out;
}
async function expectedChecksum(http, plan, signal) {
  try {
    const { body } = await http.text(plan.checksumUrl, { ...signal !== void 0 ? { signal } : {} });
    return parseChecksums(body).get(plan.asset);
  } catch {
    return void 0;
  }
}
async function installStandalone(http, plan, progress) {
  progress.onStep?.("verifying the published checksum");
  const expected = await expectedChecksum(http, plan, progress.signal);
  progress.onStep?.(`downloading ${plan.asset}`);
  const { data } = await http.buffer(plan.url, {
    maxBytes: MAX_BINARY_BYTES,
    ...progress.signal !== void 0 ? { signal: progress.signal } : {},
    onProgress: (received, total) => {
      if (total !== void 0) progress.onProgress?.(received / total);
    }
  });
  const actual = createHash("sha256").update(data).digest("hex");
  if (expected !== void 0 && actual !== expected) {
    throw new VectraxError("The downloaded yt-dlp binary failed its checksum check.", {
      code: "E_NETWORK",
      hint: "Vectrax refused to install it. This can mean a corrupted download or a tampered mirror.",
      details: { expected, actual }
    });
  }
  if (expected === void 0) {
    progress.onStep?.("published checksums unavailable, continuing without verification");
  }
  await ensureDir(path11.dirname(plan.destination));
  const staging = `${plan.destination}.partial`;
  try {
    await writeFile4(staging, data);
    if (!isWindows()) await chmod(staging, 493);
    await rename4(staging, plan.destination);
  } catch (error) {
    await removeQuietly(staging);
    throw new VectraxError(`Could not write ${plan.destination}: ${errorMessage(error)}`, {
      code: "E_FS",
      exitCode: ExitCode.FilesystemError
    });
  }
}
async function performInstall(http, plan, progress = {}) {
  if (plan.kind === "download") {
    await installStandalone(http, plan, progress);
    return;
  }
  progress.onStep?.(`running ${plan.description}`);
  await runCommand(plan.command, plan.args, progress.signal, (line) => progress.onStep?.(line));
}

// src/core/convert/ffmpeg.ts
import { spawn as spawn3 } from "child_process";
import { rename as rename5, stat as stat3 } from "fs/promises";
import path12 from "path";
var CONVERT_TIMEOUT_MS = 30 * 6e4;
var cached2;
async function detectToolchain() {
  if (cached2 !== void 0) return cached2 ?? void 0;
  const ffmpeg = await findExecutable("ffmpeg");
  if (ffmpeg === void 0) {
    cached2 = null;
    return void 0;
  }
  cached2 = {
    ffmpeg,
    ffprobe: await findExecutable("ffprobe")
  };
  return cached2;
}
function ffmpegInstruction() {
  if (isWindows()) return "winget install Gyan.FFmpeg";
  return process.platform === "darwin" ? "brew install ffmpeg" : "your package manager, e.g. apt install ffmpeg";
}
function run(command, args, signal, onLine) {
  return new Promise((resolve2, reject) => {
    const child = spawn3(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new VectraxError("ffmpeg timed out.", { code: "E_TIMEOUT" })));
    }, CONVERT_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason ?? new Error("Aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text2 = chunk.toString("utf8");
      stderr += text2;
      for (const line of text2.split(/\r?\n/)) {
        if (line.trim() !== "") onLine?.(line.trim());
      }
    });
    child.on("error", (error) => {
      finish(() => reject(new VectraxError(`Could not run ${path12.basename(command)}: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve2(stdout);
        else reject(new VectraxError(`ffmpeg exited with code ${code}.`, { hint: lastError(stderr) }));
      });
    });
  });
}
function lastError(stderr) {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("frame=") && !line.startsWith("size="));
  return lines[lines.length - 1];
}
async function probeSource(tools, file, signal) {
  const extension = path12.extname(file).slice(1).toLowerCase();
  if (tools.ffprobe === void 0) {
    return { extension, audioCodec: void 0, videoCodec: void 0, audioBitrate: void 0 };
  }
  const output2 = await run(
    tools.ffprobe,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    signal
  ).catch(() => "");
  let parsed = {};
  try {
    parsed = JSON.parse(output2);
  } catch {
  }
  const streams = parsed.streams ?? [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const video = streams.find((stream) => stream.codec_type === "video" && stream.codec_name !== "mjpeg");
  const bitrate = Number(audio?.bit_rate ?? parsed.format?.bit_rate);
  return {
    extension,
    audioCodec: audio?.codec_name,
    videoCodec: video?.codec_name,
    audioBitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : void 0
  };
}
var METADATA_KEYS = [
  ["title", "title"],
  ["artist", "artist"],
  ["album", "album"],
  ["albumArtist", "album_artist"],
  ["genre", "genre"],
  ["composer", "composer"],
  ["comment", "comment"]
];
function metadataArgs(metadata) {
  const args = ["-map_metadata", "-1"];
  if (metadata === void 0) return args;
  for (const [field, key] of METADATA_KEYS) {
    const value = metadata[field];
    if (typeof value === "string" && value !== "") args.push("-metadata", `${key}=${value}`);
  }
  if (metadata.year !== void 0) args.push("-metadata", `date=${metadata.year}`);
  if (metadata.track !== void 0) {
    const total = metadata.trackTotal !== void 0 ? `/${metadata.trackTotal}` : "";
    args.push("-metadata", `track=${metadata.track}${total}`);
  }
  return args;
}
async function convertFile(tools, source, target, options = {}) {
  const probe = await probeSource(tools, source, options.signal);
  const plan = planConversion(probe, target);
  if (plan.action === "none") {
    return { path: source, action: "none", warning: void 0 };
  }
  const destination = path12.join(path12.dirname(source), `${path12.basename(source, path12.extname(source))}.${target}`);
  const staging = `${destination}.converting.${target}`;
  try {
    await run(
      tools.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-stats",
        "-y",
        "-i",
        source,
        ...plan.args,
        ...metadataArgs(options.metadata),
        staging
      ],
      options.signal,
      (line) => {
        const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (match !== null) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          options.onProgress?.(seconds);
        }
      }
    );
    const info = await stat3(staging);
    if (info.size === 0) throw new VectraxError("ffmpeg produced an empty file.");
    if (destination !== source) await removeQuietly(destination);
    await rename5(staging, destination);
    if (destination !== source) await removeQuietly(source);
    return { path: destination, action: plan.action, warning: plan.warning };
  } catch (error) {
    await removeQuietly(staging);
    if (error instanceof VectraxError) throw error;
    throw new VectraxError(`Could not convert to ${target}: ${errorMessage(error)}`, {
      code: "E_INTERNAL",
      exitCode: ExitCode.Failure
    });
  }
}

// src/ui/live.ts
var LiveRegion = class {
  stream;
  frameIntervalMs;
  reservedRows;
  lines = [];
  renderedCount = 0;
  lastFrame = "";
  timer;
  lastRenderAt = 0;
  active = false;
  onResize = () => {
    this.lastFrame = "";
    this.flush();
  };
  constructor(options = {}) {
    this.stream = options.stream ?? process.stderr;
    this.frameIntervalMs = options.frameIntervalMs ?? 80;
    this.reservedRows = options.reservedRows ?? 1;
  }
  get supported() {
    return this.stream.isTTY === true;
  }
  get columns() {
    return usableColumns(this.stream);
  }
  get maxRows() {
    return Math.max(1, usableRows(this.stream) - this.reservedRows);
  }
  start() {
    if (!this.supported || this.active) return;
    this.active = true;
    this.stream.write(ansi.hideCursor);
    this.stream.on("resize", this.onResize);
  }
  update(lines) {
    this.lines = lines.slice(0, this.maxRows);
    if (!this.active) return;
    const now = Date.now();
    const elapsed = now - this.lastRenderAt;
    if (elapsed >= this.frameIntervalMs) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = void 0;
      this.flush();
    }, this.frameIntervalMs - elapsed).unref();
  }
  flush() {
    if (!this.active) return;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    const frame2 = this.lines.join("\n");
    if (frame2 === this.lastFrame && this.renderedCount === this.lines.length) return;
    this.lastFrame = frame2;
    this.lastRenderAt = Date.now();
    const width = this.columns - (process.platform === "win32" ? 1 : 0);
    let out = this.renderedCount > 0 ? ansi.cursorUp(this.renderedCount) + ansi.cursorHome : "";
    for (const line of this.lines) {
      out += `${ansi.clearLine}${clip(line, width)}
`;
    }
    const surplus = this.renderedCount - this.lines.length;
    if (surplus > 0) {
      out += `${ansi.clearLine}
`.repeat(surplus) + ansi.cursorUp(surplus);
    }
    this.stream.write(out);
    this.renderedCount = this.lines.length;
  }
  stop(persist = true) {
    if (!this.active) return;
    this.flush();
    if (!persist && this.renderedCount > 0) {
      this.stream.write(ansi.cursorUp(this.renderedCount) + ansi.cursorHome);
      this.stream.write(`${ansi.clearLine}
`.repeat(this.renderedCount));
      this.stream.write(ansi.cursorUp(this.renderedCount));
    }
    this.stream.removeListener("resize", this.onResize);
    this.stream.write(ansi.showCursor);
    this.active = false;
    this.renderedCount = 0;
    this.lastFrame = "";
  }
};
var ESC = "\x1B";
function clip(line, width) {
  let used = 0;
  let index = 0;
  let out = "";
  while (index < line.length) {
    if (line[index] === ESC) {
      const end = line.indexOf("m", index);
      if (end === -1) break;
      out += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const char = String.fromCodePoint(line.codePointAt(index));
    const charWidth = displayWidth(char);
    if (used + charWidth > width) {
      return `${out}${ansi.reset}`;
    }
    out += char;
    used += charWidth;
    index += char.length;
  }
  return out;
}

// src/ui/progress.ts
var BAR_GLYPHS = { full: glyph.barFull, partial: glyph.barPartial, empty: glyph.barEmpty };
var DownloadDashboard = class {
  logger;
  total;
  live;
  interactive;
  tasks = /* @__PURE__ */ new Map();
  announced = /* @__PURE__ */ new Set();
  ticker;
  pulse = 0;
  constructor(options) {
    this.logger = options.logger;
    this.total = options.total;
    this.live = new LiveRegion({ stream: options.logger.stderr, frameIntervalMs: 80, reservedRows: 2 });
    this.interactive = options.plain !== true && this.live.supported && options.logger.isInteractive;
  }
  start() {
    if (!this.interactive) return;
    this.live.start();
    this.ticker = setInterval(() => {
      this.pulse++;
      this.render();
    }, 90).unref();
  }
  handle(snapshot) {
    this.tasks.set(snapshot.id, snapshot);
    if (this.interactive) this.render();
    else this.announce(snapshot);
  }
  stop() {
    if (this.ticker !== void 0) clearInterval(this.ticker);
    this.ticker = void 0;
    if (this.interactive) this.live.stop(false);
  }
  announce(snapshot) {
    const settled = snapshot.state === "completed" || snapshot.state === "failed" || snapshot.state === "skipped";
    if (!settled || this.announced.has(snapshot.id)) return;
    this.announced.add(snapshot.id);
    const position = `[${this.announced.size}/${this.total}]`;
    if (snapshot.state === "completed") {
      this.logger.success(`${position} ${snapshot.title} ${c.muted(`(${formatBytes(snapshot.received)})`)}`);
    } else if (snapshot.state === "skipped") {
      this.logger.info(`${position} ${snapshot.title} ${c.muted("(already present, skipped)")}`);
    } else {
      this.logger.error(`${position} ${snapshot.title} ${c.muted(`\u2014 ${snapshot.error ?? "failed"}`)}`);
    }
  }
  aggregate() {
    const snapshots = [...this.tasks.values()];
    const completed = snapshots.filter((task) => task.state === "completed").length;
    const skipped = snapshots.filter((task) => task.state === "skipped").length;
    const failed = snapshots.filter((task) => task.state === "failed").length;
    const active = snapshots.filter(
      (task) => task.state === "downloading" || task.state === "probing" || task.state === "retrying"
    );
    const received = snapshots.reduce((sum, task) => sum + task.received, 0);
    const totalBytes = snapshots.reduce((sum, task) => sum + (task.total ?? task.received), 0);
    const speed = active.reduce((sum, task) => sum + task.speed, 0);
    const remaining = totalBytes - received;
    return {
      completed,
      skipped,
      failed,
      settled: completed + skipped + failed,
      active,
      received,
      totalBytes,
      speed,
      etaMs: speed > 1 && remaining > 0 ? remaining / speed * 1e3 : void 0
    };
  }
  render() {
    const columns = this.live.columns;
    const size = breakpointFor(columns);
    const stats = this.aggregate();
    const lines = [this.renderHeader(stats, columns)];
    const windowSize = Math.max(1, this.live.maxRows - (size === "micro" ? 2 : 3));
    const visible = stats.active.slice(0, windowSize);
    for (const task of visible) lines.push(this.renderRow(task, columns));
    const hidden = stats.active.length - visible.length;
    if (hidden > 0) lines.push(c.muted(`  ${glyph.bullet} ${hidden} more in flight`));
    lines.push(this.renderFooter(stats, columns));
    this.live.update(lines);
  }
  renderHeader(stats, columns) {
    const ratio = stats.totalBytes > 0 ? stats.received / stats.totalBytes : 0;
    const size = breakpointFor(columns);
    const counter = c.text(`${stats.settled}/${this.total}`);
    const percent = c.bold(c.text(formatPercent(ratio)));
    if (size === "micro") {
      return `  ${c.accent(glyph.barFull)} ${counter} ${percent}`;
    }
    const size_ = c.muted(`${formatBytes(stats.received)} / ${formatBytes(stats.totalBytes)}`);
    const rate = c.accentBright(padStart(formatRate(stats.speed), 10));
    const eta = c.muted(`eta ${formatEta(stats.etaMs)}`);
    const trailing = size === "compact" ? size_ : `${size_}  ${rate}  ${eta}`;
    const fixed = displayWidth(`  ${glyph.barFull}  ${stats.settled}/${this.total}   100%    `);
    const barWidth = Math.max(6, Math.min(34, columns - fixed - displayWidth(trailing) - 4));
    const bar = this.reactiveBar(ratio, barWidth);
    return `  ${c.accent(glyph.barFull)}  ${counter}  ${bar}${percent}  ${trailing}`;
  }
  reactiveBar(ratio, width) {
    const bar = renderBar(ratio, width, BAR_GLYPHS);
    if (ratio <= 0 || ratio >= 1) return c.accent(bar);
    const filled = Math.floor(Math.min(1, Math.max(0, ratio)) * width);
    if (filled >= width) return c.accent(bar);
    const head = [...bar].slice(0, filled).join("");
    const tail = [...bar].slice(filled + 1).join("");
    return c.accent(head) + c.accentBright(reactionEdge(this.pulse)) + c.muted(tail);
  }
  renderRow(task, columns) {
    const spinner = c.accent(glyph.spinner[this.pulse % glyph.spinner.length]);
    const plan = planColumns(columns);
    if (task.state === "probing") {
      return `  ${spinner} ${c.text(truncate(task.title, plan.title))} ${c.muted("resolving")}`;
    }
    if (task.state === "retrying") {
      return `  ${c.warn(glyph.warn)} ${c.text(truncate(task.title, plan.title))} ${c.warn(`retry ${task.attempt}`)}`;
    }
    const ratio = task.total !== void 0 && task.total > 0 ? task.received / task.total : 0;
    const name = c.text(fit(task.title, plan.title));
    const resumed = task.resumedFrom > 0 ? c.info("\u21BA") : "";
    const parts = [`  ${spinner} ${name}${resumed}`];
    if (plan.bar > 0) parts.push(this.reactiveBar(ratio, plan.bar));
    parts.push(c.text(formatPercent(ratio)));
    if (plan.showStats) {
      const total = task.total !== void 0 ? ` / ${formatBytes(task.total)}` : "";
      parts.push(c.muted(`${formatBytes(task.received)}${total}`));
    }
    if (plan.showRate) parts.push(c.accentBright(padStart(formatRate(task.speed), 10)));
    if (plan.showEta) parts.push(c.muted(formatEta(task.etaMs)));
    return parts.join("  ");
  }
  renderFooter(stats, columns) {
    const queued = this.total - stats.settled - stats.active.length;
    const parts = [];
    if (queued > 0) parts.push(c.muted(`${queued} queued`));
    if (stats.completed > 0) parts.push(c.success(`${stats.completed} done`));
    if (stats.skipped > 0) parts.push(c.muted(`${stats.skipped} skipped`));
    if (stats.failed > 0) parts.push(c.danger(`${stats.failed} failed`));
    if (breakpointFor(columns) !== "micro") parts.push(c.muted("ctrl+c stops, progress is kept"));
    return `  ${parts.join(c.muted(`  ${glyph.bullet}  `))}`;
  }
};

// src/ui/prompts.ts
import { readdir } from "fs/promises";
import path13 from "path";
import readline from "readline";
var input = process.stdin;
var output = process.stderr;
function isInteractiveSession() {
  return input.isTTY === true && output.isTTY === true;
}
function requireTty(what, flag) {
  if (isInteractiveSession()) return;
  throw new UsageError(`${what} requires an interactive terminal.`, {
    hint: `Re-run with ${flag} to answer this non-interactively.`
  });
}
function withKeys(handler) {
  return new Promise((resolve2, reject) => {
    const wasRaw = input.isRaw === true;
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.removeListener("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
    };
    const api = {
      resolve: (value) => {
        cleanup();
        resolve2(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      }
    };
    const { onKey, render } = handler(api);
    const onKeypress = (str, key = {}) => {
      if (key.ctrl === true && key.name === "c") {
        api.reject(new CancelledError());
        return;
      }
      onKey(str, key);
    };
    input.on("keypress", onKeypress);
    render();
  });
}
async function confirm(options) {
  requireTty("Confirmation", options.flag ?? "--yes");
  let value = options.initial ?? true;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 0 });
  region.start();
  const draw = () => {
    const yes = value ? c.onAccent(" yes ") : c.muted(" yes ");
    const no = value ? c.muted(" no ") : c.onAccent(" no ");
    region.update([`${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))}  ${yes} ${no}`]);
  };
  try {
    return await withKeys(({ resolve: resolve2, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? "";
        if (name === "left" || name === "right" || name === "tab" || name === "h" || name === "l") {
          value = !value;
          draw();
        } else if (str?.toLowerCase() === "y") {
          value = true;
          resolve2(true);
        } else if (str?.toLowerCase() === "n") {
          value = false;
          resolve2(false);
        } else if (name === "return" || name === "enter") {
          resolve2(value);
        } else if (name === "escape") {
          reject(new CancelledError());
        }
      }
    }));
  } finally {
    region.stop(false);
    output.write(
      `${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(value ? "yes" : "no")}
`
    );
  }
}
async function text(options) {
  requireTty("Text input", options.flag ?? "--output");
  let value = options.initial ?? "";
  let error;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 0 });
  region.start();
  const draw = () => {
    const shown = value === "" ? c.muted(options.placeholder ?? "") : c.text(value) + c.accent(glyph.barFull);
    const lines = [`${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))} ${shown}`];
    if (error !== void 0) lines.push(`  ${c.danger(glyph.cross)} ${c.danger(error)}`);
    else if (options.hint !== void 0) lines.push(`  ${c.muted(options.hint)}`);
    region.update(lines);
  };
  try {
    return await withKeys(({ resolve: resolve2, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? "";
        if (name === "return" || name === "enter") {
          const message = options.validate?.(value);
          if (message !== void 0) {
            error = message;
            draw();
            return;
          }
          resolve2(value);
          return;
        }
        if (name === "escape") {
          reject(new CancelledError());
          return;
        }
        if (name === "backspace") {
          value = [...value].slice(0, -1).join("");
        } else if (key.ctrl === true && name === "u") {
          value = "";
        } else if (key.ctrl === true && name === "w") {
          value = value.replace(/\S+\s*$/, "");
        } else if (str !== void 0 && key.ctrl !== true && key.meta !== true && !/[\u0000-\u001F\u007F]/.test(str)) {
          value += str;
        } else {
          return;
        }
        error = void 0;
        draw();
      }
    }));
  } finally {
    region.stop(false);
    output.write(`${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(value)}
`);
  }
}
async function multiSelect(options) {
  requireTty("Selection", options.flag ?? "--all or --select");
  if (options.items.length === 0) return [];
  const selected = new Set(
    options.items.flatMap((item, index) => item.selected === true ? [index] : [])
  );
  let cursor = 0;
  let offset = 0;
  let error;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 1 });
  region.start();
  const pageSize = () => Math.max(3, Math.min(options.items.length, region.maxRows - 4));
  const draw = () => {
    const size = pageSize();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + size) offset = cursor - size + 1;
    offset = Math.max(0, Math.min(offset, options.items.length - size));
    const columns = region.columns;
    const lines = [
      `${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))} ${c.muted(`(${selected.size}/${options.items.length} selected)`)}`
    ];
    for (let index = offset; index < Math.min(offset + size, options.items.length); index++) {
      const item = options.items[index];
      const isCursor = index === cursor;
      const isChecked = selected.has(index);
      const box = isChecked ? c.accent(glyph.checkOn) : c.muted(glyph.checkOff);
      const pointer = isCursor ? c.accent(glyph.pointer) : " ";
      const number = c.muted(String(index + 1).padStart(String(options.items.length).length));
      const hint = item.hint ?? "";
      const reserved = displayWidth(`  ${glyph.pointer} ${glyph.checkOn} ${number}  ${hint}  `);
      const label = truncate(item.label, Math.max(8, columns - reserved));
      const styled = isCursor ? c.bold(c.text(label)) : isChecked ? c.text(label) : c.muted(label);
      const pad = " ".repeat(
        Math.max(1, columns - reserved - displayWidth(label) + 1)
      );
      lines.push(`  ${pointer} ${box} ${number} ${styled}${pad}${c.muted(hint)}`);
    }
    if (options.items.length > size) {
      lines.push(c.muted(`    ${offset + 1}\u2013${Math.min(offset + size, options.items.length)} of ${options.items.length}`));
    }
    lines.push(
      error !== void 0 ? `  ${c.danger(glyph.cross)} ${c.danger(error)}` : c.muted(`    space toggle  ${glyph.bullet}  a all  ${glyph.bullet}  i invert  ${glyph.bullet}  enter confirm  ${glyph.bullet}  esc cancel`)
    );
    region.update(lines);
  };
  try {
    return await withKeys(({ resolve: resolve2, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? "";
        const last = options.items.length - 1;
        if (name === "up" || name === "k") cursor = cursor === 0 ? last : cursor - 1;
        else if (name === "down" || name === "j") cursor = cursor === last ? 0 : cursor + 1;
        else if (name === "pageup") cursor = Math.max(0, cursor - pageSize());
        else if (name === "pagedown") cursor = Math.min(last, cursor + pageSize());
        else if (name === "home") cursor = 0;
        else if (name === "end") cursor = last;
        else if (name === "space") {
          if (selected.has(cursor)) selected.delete(cursor);
          else selected.add(cursor);
          error = void 0;
        } else if (str === "a") {
          if (selected.size === options.items.length) selected.clear();
          else options.items.forEach((_, index) => selected.add(index));
          error = void 0;
        } else if (str === "i") {
          options.items.forEach((_, index) => {
            if (selected.has(index)) selected.delete(index);
            else selected.add(index);
          });
          error = void 0;
        } else if (name === "return" || name === "enter") {
          if (options.required === true && selected.size === 0) {
            error = "Select at least one item, or press esc to cancel.";
            draw();
            return;
          }
          resolve2(
            [...selected].sort((a, b) => a - b).map((index) => options.items[index].value)
          );
          return;
        } else if (name === "escape" || str === "q") {
          reject(new CancelledError());
          return;
        } else {
          return;
        }
        draw();
      }
    }));
  } finally {
    region.stop(false);
    output.write(
      `${c.accent(glyph.pointer)} ${c.muted(options.message)} ${c.accentBright(`${selected.size} selected`)}
`
    );
  }
}
async function browseDirectory(options) {
  requireTty("Directory browsing", "--output <dir>");
  let current = path13.resolve(options.startPath ?? process.cwd());
  let entries = [];
  let cursor = 0;
  let offset = 0;
  let notice;
  const region = new LiveRegion({ stream: output, frameIntervalMs: 0, reservedRows: 1 });
  region.start();
  const pageSize = () => Math.max(3, Math.min(20, region.maxRows - 5));
  const load = async (dir) => {
    try {
      const found = await readdir(dir, { withFileTypes: true });
      entries = found.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
      current = dir;
      cursor = 0;
      offset = 0;
      notice = void 0;
    } catch {
      notice = "Cannot read that directory.";
    }
  };
  const draw = () => {
    const size = pageSize();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + size) offset = cursor - size + 1;
    const lines = [
      `${c.accent(glyph.pointer)} ${c.bold(c.text(options.message))}`,
      `  ${c.muted(truncate(current, region.columns - 4))}`
    ];
    if (entries.length === 0) {
      lines.push(`  ${c.muted("(no sub-directories)")}`);
    }
    for (let index = offset; index < Math.min(offset + size, entries.length); index++) {
      const name = entries[index];
      const isCursor = index === cursor;
      const pointer = isCursor ? c.accent(glyph.pointer) : " ";
      const label = truncate(name, region.columns - 8);
      lines.push(`  ${pointer} ${c.accentDeep(glyph.arrow)} ${isCursor ? c.bold(c.text(label)) : c.muted(label)}`);
    }
    lines.push(
      notice !== void 0 ? `  ${c.danger(glyph.cross)} ${c.danger(notice)}` : c.muted(`    ${glyph.arrow} enter open  ${glyph.bullet}  \u2190 up  ${glyph.bullet}  s select this folder  ${glyph.bullet}  esc cancel`)
    );
    region.update(lines);
  };
  await load(current);
  try {
    return await withKeys(({ resolve: resolve2, reject }) => ({
      render: draw,
      onKey: (str, key) => {
        const name = key.name ?? "";
        const last = entries.length - 1;
        if (name === "up" || name === "k") cursor = cursor <= 0 ? Math.max(0, last) : cursor - 1;
        else if (name === "down" || name === "j") cursor = cursor >= last ? 0 : cursor + 1;
        else if (name === "left" || name === "backspace") {
          const parent = path13.dirname(current);
          if (parent !== current) void load(parent).then(draw);
          return;
        } else if (name === "right" || name === "return" || name === "enter") {
          const target = entries[cursor];
          if (target === void 0) return;
          void load(path13.join(current, target)).then(draw);
          return;
        } else if (str === "s" || key.ctrl === true && name === "d") {
          resolve2(current);
          return;
        } else if (name === "escape" || str === "q") {
          reject(new CancelledError());
          return;
        } else {
          return;
        }
        draw();
      }
    }));
  } finally {
    region.stop(false);
  }
}

// src/cli/commands/get.ts
async function runGet(ctx, rawUrl, options) {
  const url = parseUrl(rawUrl, {
    allowPrivateHosts: ctx.config.allowPrivateHosts,
    allowInsecure: ctx.config.allowInsecure
  });
  const kinds = options.kinds ?? kindsForIntent(options.media, ctx.config.kinds);
  const outputDir = resolvePath(ctx.config.outputDir);
  ctx.logger.step(`Resolving ${c.accent(url.host)}${c.muted(truncate(url.pathname, 48))}`);
  const discovery = await discoverWithFallback(ctx.http, url, {
    kinds,
    ...options.extensions !== void 0 ? { extensions: options.extensions } : {},
    match: options.match,
    media: options.media,
    quality: options.quality,
    limit: options.limit,
    signal: ctx.signal
  });
  for (const warning of discovery.warnings) ctx.logger.warn(warning);
  if (discovery.items.length === 0) throw noMediaError(discovery, kinds);
  const referer = resolveReferer(ctx.config.referer, discovery.direct ? void 0 : discovery.pageUrl);
  ctx.logger.success(
    `Found ${c.bold(c.text(pluralize(discovery.items.length, "file")))}` + (discovery.pageTitle !== void 0 ? c.muted(` on \u201C${truncate(discovery.pageTitle, 44)}\u201D`) : "")
  );
  const candidates = options.sizes ? await probeSizes(ctx.http, discovery.items, {
    concurrency: ctx.config.concurrency,
    referer,
    signal: ctx.signal
  }) : [...discovery.items];
  const selected = await selectCandidates(ctx, candidates, options);
  if (selected.length === 0) {
    ctx.logger.warn("Nothing selected.");
    return ExitCode.NoResults;
  }
  ctx.logger.blank();
  ctx.logger.field("Files", String(selected.length));
  ctx.logger.field("Destination", outputDir);
  if (options.dryRun) ctx.logger.field("Mode", "dry run \u2014 nothing will be written");
  if (!options.yes && !options.dryRun && isInteractiveSession() && ctx.flags.json !== true) {
    ctx.logger.blank();
    const proceed = await confirm({
      message: `Download ${pluralize(selected.length, "file")}?`,
      initial: true,
      flag: "--yes"
    });
    if (!proceed) {
      ctx.logger.info("Cancelled.");
      return ExitCode.Ok;
    }
  }
  await ensureWritableDir(outputDir);
  const requests = selected.map((item, index) => ({
    id: `${index}`,
    url: item.url,
    title: item.title,
    outputDir,
    ...item.headers !== void 0 ? { headers: item.headers } : {},
    ...item.headers?.["referer"] === void 0 && referer !== void 0 ? { referer } : {},
    ...item.filename !== void 0 ? { filename: item.filename } : {},
    ...item.failureHint !== void 0 ? { failureHint: item.failureHint } : {},
    ..."size" in item && item.size !== void 0 ? { expectedSize: item.size } : {}
  }));
  const dashboard = options.dryRun ? void 0 : new DownloadDashboard({
    logger: ctx.logger,
    total: requests.length,
    plain: ctx.flags.json === true
  });
  const engine = new DownloadEngine(ctx.http, {
    concurrency: ctx.config.concurrency,
    retries: ctx.config.retries,
    stallTimeoutMs: ctx.config.stallTimeoutMs,
    conflict: ctx.config.conflict,
    resume: ctx.config.resume,
    dryRun: options.dryRun,
    ...dashboard !== void 0 ? { onUpdate: (snapshot) => dashboard.handle(snapshot) } : {}
  });
  ctx.logger.blank();
  const startedAt = Date.now();
  dashboard?.start();
  let outcomes;
  try {
    outcomes = await engine.run(requests, ctx.signal);
  } finally {
    dashboard?.stop();
  }
  const recovered = await recoverFailures(ctx, outcomes, selected, options);
  const converted = await convertOutputs(ctx, outcomes, selected, options);
  const elapsedMs = Date.now() - startedAt;
  const completedOutcomes = outcomes.filter((o) => o.state === "completed");
  const tagging = options.tag && !options.dryRun ? await tagDownloads(ctx, completedOutcomes, selected, options) : void 0;
  const completed = outcomes.filter((o) => o.state === "completed");
  const skipped = outcomes.filter((o) => o.state === "skipped");
  const failed = outcomes.filter((o) => o.state === "failed");
  const cancelled = outcomes.filter((o) => o.state === "cancelled");
  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      url: discovery.pageUrl.href,
      outputDir,
      durationMs: elapsedMs,
      summary: {
        total: outcomes.length,
        completed: completed.length,
        skipped: skipped.length,
        failed: failed.length,
        cancelled: cancelled.length,
        bytes: completed.reduce((sum, o) => sum + o.bytes, 0),
        ...tagging !== void 0 ? { tagged: tagging.tagged } : {}
      },
      results: outcomes.map((o) => ({
        url: o.request.url,
        title: o.request.title,
        state: o.state,
        path: o.path ?? null,
        bytes: o.bytes,
        resumed: o.resumed,
        error: o.error !== void 0 ? errorMessage(o.error) : null
      }))
    });
  } else {
    printSummary(ctx, {
      completed,
      skipped,
      failed,
      cancelled,
      elapsedMs,
      outputDir,
      dryRun: options.dryRun,
      tagging,
      recovered,
      converted
    });
  }
  if (completed.length > 0 && !options.dryRun) {
    await maybeMove(ctx, completed, options);
  }
  if (cancelled.length > 0) return ExitCode.Interrupted;
  if (failed.length > 0) return completed.length > 0 ? ExitCode.PartialFailure : ExitCode.NetworkError;
  return ExitCode.Ok;
}
async function selectCandidates(ctx, candidates, options) {
  if (options.select !== void 0) {
    return parseSelection(options.select, candidates.length).map(
      (index) => candidates[index]
    );
  }
  if (options.all || candidates.length === 1) return [...candidates];
  if (!isInteractiveSession() || ctx.flags.json === true) {
    throw new VectraxError(`Found ${candidates.length} files but no selection was given.`, {
      code: "E_USAGE",
      exitCode: ExitCode.UsageError,
      hint: "Pass --all to take everything, or --select 1,3,5-8 to choose."
    });
  }
  ctx.logger.blank();
  return multiSelect({
    message: "Select files to download",
    required: true,
    flag: "--all or --select",
    items: candidates.map((item) => ({
      value: item,
      label: item.title,
      hint: [describeFormat(item), "size" in item && item.size !== void 0 ? formatBytes(item.size) : void 0].filter((v) => v !== void 0 && v !== "").join("  ")
    }))
  });
}
function printSummary(ctx, data) {
  const bytes = data.completed.reduce((sum, o) => sum + o.bytes, 0);
  const resumed = data.completed.filter((o) => o.resumed).length;
  ctx.logger.heading(data.dryRun ? "dry run" : "summary");
  if (data.dryRun) {
    ctx.logger.success(
      `${pluralize(data.completed.length, "file")} would be downloaded ${c.muted(`(~${formatBytes(bytes)})`)}`
    );
    for (const outcome of data.completed) {
      const name = outcome.path !== void 0 ? path14.basename(outcome.path) : outcome.request.title;
      ctx.logger.detail(`${c.muted(glyph.arrow)} ${truncate(name, ctx.logger.columns - 6)}`);
    }
    return;
  }
  if (data.completed.length > 0) {
    ctx.logger.success(
      `${pluralize(data.completed.length, "file")} downloaded ${c.muted(
        `(${formatBytes(bytes)} in ${formatDuration(data.elapsedMs)} @ ${formatRate(bytes / Math.max(1, data.elapsedMs) * 1e3)})`
      )}`
    );
  }
  if (resumed > 0) ctx.logger.detail(`${resumed} resumed from a previous run`);
  if (data.converted > 0) {
    ctx.logger.detail(`${pluralize(data.converted, "file")} converted`);
  }
  if (data.recovered !== void 0) {
    ctx.logger.detail(
      `${pluralize(data.recovered.count, "file")} recovered via ${path14.basename(data.recovered.tool.binary)}`
    );
  }
  if (data.tagging !== void 0 && data.tagging.tagged > 0) {
    ctx.logger.detail(`${pluralize(data.tagging.tagged, "file")} tagged with metadata`);
  }
  for (const warning of data.tagging?.warnings ?? []) {
    ctx.logger.detail(`${c.warn(glyph.warn)} could not tag ${warning}`);
  }
  if (data.skipped.length > 0) {
    ctx.logger.info(`${pluralize(data.skipped.length, "file")} skipped ${c.muted("(already present)")}`);
  }
  if (data.cancelled.length > 0) {
    ctx.logger.warn(`${pluralize(data.cancelled.length, "file")} cancelled ${c.muted("(re-run to resume)")}`);
  }
  if (data.failed.length > 0) {
    ctx.logger.error(`${pluralize(data.failed.length, "file")} failed`);
    const seenHints = /* @__PURE__ */ new Set();
    for (const outcome of data.failed) {
      ctx.logger.detail(
        `${c.danger(glyph.cross)} ${truncate(outcome.request.title, 44)} ${c.muted(`\u2014 ${errorMessage(outcome.error)}`)}`
      );
      const hint = isVectraxError(outcome.error) ? outcome.error.hint : void 0;
      if (hint !== void 0 && !seenHints.has(hint)) {
        seenHints.add(hint);
        ctx.logger.detail(`  ${c.muted(hint)}`);
      }
    }
  }
  if (data.completed.length > 0) {
    ctx.logger.blank();
    ctx.logger.field("Saved to", data.outputDir);
  }
}
async function maybeMove(ctx, completed, options) {
  let target = options.move !== void 0 ? resolvePath(options.move) : void 0;
  if (target === void 0) {
    if (options.yes || !isInteractiveSession() || ctx.flags.json === true) return;
    ctx.logger.blank();
    const wants = await confirm({ message: "Move these files somewhere else?", initial: false, flag: "--move" });
    if (!wants) return;
    target = await promptForDirectory(ctx);
    if (target === void 0) return;
  }
  await ensureWritableDir(target);
  ctx.logger.blank();
  ctx.logger.step(`Moving ${pluralize(completed.length, "file")} to ${c.accent(target)}`);
  const results = await mapPool(
    completed,
    async (outcome) => {
      const source = outcome.path;
      const destination = await uniquePath(target, path14.basename(source));
      await moveFile(source, destination);
      return destination;
    },
    { limit: 1, signal: ctx.signal }
  );
  const moved = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - moved;
  if (moved > 0) ctx.logger.success(`${pluralize(moved, "file")} moved`);
  if (failed > 0) {
    ctx.logger.error(`${pluralize(failed, "file")} could not be moved`);
    for (const result of results) {
      if (result.status === "rejected") ctx.logger.detail(errorMessage(result.reason));
    }
  }
}
async function promptForDirectory(ctx) {
  try {
    const answer = await text({
      message: "Destination",
      placeholder: "type a path, or leave empty to browse",
      hint: "enter accepts \u2022 esc cancels",
      flag: "--move <dir>"
    });
    if (answer.trim() === "") return await browseDirectory({ message: "Choose a destination folder" });
    return resolvePath(answer);
  } catch (error) {
    if (isAbortError(error) || error instanceof CancelledError) {
      ctx.logger.info("Move cancelled \u2014 files remain in the download directory.");
      return void 0;
    }
    throw error;
  }
}
async function tagDownloads(ctx, completed, selected, options) {
  const jobs = [];
  for (const outcome of completed) {
    if (outcome.path === void 0 || !supportsTagging(outcome.path)) continue;
    const candidate = selected[Number(outcome.request.id)];
    const metadata = candidate?.metadata;
    if (metadata === void 0) continue;
    jobs.push({
      path: outcome.path,
      metadata,
      ...options.artwork && candidate?.artworkUrl !== void 0 ? { artworkUrl: candidate.artworkUrl } : {}
    });
  }
  if (jobs.length === 0) return void 0;
  const report = await applyMetadata(ctx.http, jobs, {
    artwork: options.artwork,
    concurrency: ctx.config.concurrency,
    signal: ctx.signal
  });
  ctx.logger.debug(`tagged ${report.tagged}/${jobs.length} files`);
  return report;
}
function fallbackTargetFor(outcome, selected) {
  if (outcome.state !== "failed") return void 0;
  const candidate = selected[Number(outcome.request.id)];
  return candidate?.fallbackUrl !== void 0 ? candidate : void 0;
}
async function recoverFailures(ctx, outcomes, selected, options) {
  if (!options.fallback || options.dryRun) return void 0;
  const targets = outcomes.map((outcome, index) => ({ outcome, index, candidate: fallbackTargetFor(outcome, selected) })).filter((entry) => entry.candidate !== void 0);
  if (targets.length === 0) return void 0;
  const tool = await detectFallbackTool() ?? await offerInstall(ctx, targets.length, options);
  if (tool === void 0) return void 0;
  ctx.logger.blank();
  ctx.logger.step(
    `Retrying ${pluralize(targets.length, "item")} with ${c.accent(path14.basename(tool.binary))} ${c.muted(tool.version)}`
  );
  let recoveredCount = 0;
  for (const { outcome, index, candidate } of targets) {
    const media = candidate;
    const label = truncate(media.title, Math.max(16, ctx.logger.columns - 24));
    try {
      const result = await runFallback(tool, {
        url: media.fallbackUrl,
        outputDir: outcome.request.outputDir,
        filename: media.filename ?? media.title,
        media: options.media,
        quality: options.quality,
        signal: ctx.signal,
        onRetry: () => ctx.logger.detail(`${label} ${c.muted("retrying without format constraints")}`)
      });
      outcomes[index] = {
        ...outcome,
        state: "completed",
        path: result.path,
        bytes: await fileSize(result.path),
        error: void 0
      };
      recoveredCount++;
      ctx.logger.success(`${label} ${c.muted("recovered")}`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      const reason = isVectraxError(error) ? error.hint ?? error.message : errorMessage(error);
      ctx.logger.error(`${label} ${c.muted(`\u2014 ${reason}`)}`);
      outcomes[index] = {
        ...outcome,
        error: new VectraxError(`${path14.basename(tool.binary)} could not download this item.`, {
          code: "E_NO_MEDIA",
          hint: reason
        })
      };
    }
  }
  return recoveredCount > 0 ? { tool, count: recoveredCount } : void 0;
}
async function offerInstall(ctx, pending, options) {
  const plan = await planInstall();
  if (plan === void 0) {
    ctx.logger.blank();
    ctx.logger.warn("yt-dlp is needed to finish this download, and Vectrax cannot install it here.");
    ctx.logger.detail(`Install it manually: ${c.accent(manualInstruction())}`);
    return void 0;
  }
  ctx.logger.blank();
  ctx.logger.warn(
    `yt-dlp is required to finish ${pluralize(pending, "item")}, and it is not installed.`
  );
  ctx.logger.detail(`Vectrax would ${plan.description}.`);
  if (!await confirmInstall(ctx, options)) {
    ctx.logger.detail(`Install it yourself with: ${c.accent(plan.manual)}`);
    return void 0;
  }
  const region = new LiveRegion({ stream: ctx.logger.stderr, frameIntervalMs: 120 });
  if (ctx.logger.isInteractive) region.start();
  try {
    await performInstall(ctx.http, plan, {
      signal: ctx.signal,
      onStep: (message) => {
        region.update([`  ${c.muted(message)}`]);
        if (!ctx.logger.isInteractive) ctx.logger.detail(message);
      },
      onProgress: (ratio) => {
        const width = Math.max(8, Math.min(24, ctx.logger.columns - 32));
        region.update([
          `  ${c.accent(renderBar(ratio, width, { full: glyph.barFull, partial: glyph.barPartial, empty: glyph.barEmpty }))} ${c.text(formatPercent(ratio))} ${c.muted("installing yt-dlp")}`
        ]);
      }
    });
    region.stop(false);
  } catch (error) {
    region.stop(false);
    if (isAbortError(error)) throw error;
    ctx.logger.blank();
    ctx.logger.error(`Could not install yt-dlp: ${errorMessage(error)}`);
    const hint = isVectraxError(error) ? error.hint : void 0;
    if (hint !== void 0) ctx.logger.detail(hint);
    ctx.logger.detail(`Install it manually and re-run: ${c.accent(plan.manual)}`);
    return void 0;
  }
  resetFallbackCache();
  const installed = await detectFallbackTool();
  if (installed === void 0) {
    ctx.logger.error("yt-dlp reported success but could not be run afterwards.");
    ctx.logger.detail(`Install it manually and re-run: ${c.accent(plan.manual)}`);
    return void 0;
  }
  ctx.logger.success(`yt-dlp ${installed.version} installed`);
  return installed;
}
async function confirmInstall(ctx, options) {
  if (options.installFallback) return true;
  if (!isInteractiveSession() || ctx.flags.json === true) {
    ctx.logger.detail("Re-run with --install-fallback to allow this without a prompt.");
    return false;
  }
  return confirm({
    message: "Install yt-dlp now?",
    initial: true,
    flag: "--install-fallback"
  });
}
async function convertOutputs(ctx, outcomes, selected, options) {
  if (options.format === KEEP_ORIGINAL || options.dryRun) return 0;
  const pending = outcomes.map((outcome, index) => ({ outcome, index })).filter((entry) => entry.outcome.state === "completed" && entry.outcome.path !== void 0);
  if (pending.length === 0) return 0;
  const tools = await detectToolchain();
  if (tools === void 0) {
    ctx.logger.blank();
    ctx.logger.warn("Format conversion needs ffmpeg, which is not installed.");
    ctx.logger.detail(`Install it with ${c.accent(ffmpegInstruction())}. Files were kept as downloaded.`);
    return 0;
  }
  let converted = 0;
  const warned = /* @__PURE__ */ new Set();
  for (const { outcome, index } of pending) {
    const source = outcome.path;
    const probeExtension = path14.extname(source).slice(1).toLowerCase();
    const target = targetFormatFor(options.format, {
      extension: probeExtension,
      audioCodec: void 0,
      videoCodec: /^(mp4|mkv|webm|m4v|mov|avi)$/.test(probeExtension) ? "unknown" : void 0,
      audioBitrate: void 0
    });
    if (target === void 0) continue;
    try {
      const candidate = selected[Number(outcome.request.id)];
      const result = await convertFile(tools, source, target, {
        signal: ctx.signal,
        ...candidate?.metadata !== void 0 ? { metadata: candidate.metadata } : {}
      });
      if (result.action === "none") continue;
      outcomes[index] = { ...outcome, path: result.path };
      converted++;
      if (result.warning !== void 0 && !warned.has(result.warning)) {
        warned.add(result.warning);
        ctx.logger.detail(`${c.warn(glyph.warn)} ${result.warning}`);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      ctx.logger.error(`Could not convert ${path14.basename(source)}: ${errorMessage(error)}`);
    }
  }
  return converted;
}

// src/cli/commands/scan.ts
async function runScan(ctx, rawUrl, options) {
  const url = parseUrl(rawUrl, {
    allowPrivateHosts: ctx.config.allowPrivateHosts,
    allowInsecure: ctx.config.allowInsecure
  });
  const kinds = options.kinds ?? kindsForIntent(options.media, ctx.config.kinds);
  ctx.logger.step(`Scanning ${c.accent(url.host)}${c.muted(truncate(url.pathname, 48))}`);
  const result = await discoverWithFallback(ctx.http, url, {
    kinds,
    ...options.extensions !== void 0 ? { extensions: options.extensions } : {},
    match: options.match,
    media: options.media,
    quality: options.quality,
    limit: options.limit,
    signal: ctx.signal
  });
  for (const warning of result.warnings) ctx.logger.warn(warning);
  if (result.items.length === 0) throw noMediaError(result, kinds);
  const items = options.sizes ? await probeSizes(ctx.http, result.items, {
    concurrency: ctx.config.concurrency,
    referer: resolveReferer(ctx.config.referer, result.direct ? void 0 : result.pageUrl),
    signal: ctx.signal
  }) : [...result.items];
  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      url: result.pageUrl.href,
      title: result.pageTitle ?? null,
      provider: result.provider,
      direct: result.direct,
      count: items.length,
      ...result.warnings.length > 0 ? { warnings: result.warnings } : {},
      items: items.map((item) => ({
        url: item.url,
        title: item.title,
        kind: item.kind,
        extension: item.extension ?? null,
        quality: item.quality ?? null,
        source: item.source,
        size: "size" in item ? item.size ?? null : null,
        ...item.durationSeconds !== void 0 ? { durationSeconds: item.durationSeconds } : {},
        ...item.metadata !== void 0 ? { metadata: item.metadata } : {}
      }))
    });
    return ExitCode.Ok;
  }
  renderTable(ctx, items, result.pageTitle);
  return ExitCode.Ok;
}
function renderTable(ctx, items, pageTitle) {
  const columns = ctx.logger.columns;
  const size = breakpointFor(columns);
  if (pageTitle !== void 0) {
    ctx.logger.blank();
    for (const line of wrap(pageTitle, columns - 4)) ctx.logger.detail(line);
  }
  ctx.logger.blank();
  const indexWidth = String(items.length).length;
  const sizes = items.map(
    (item) => "size" in item && item.size !== void 0 ? formatBytes(item.size) : ""
  );
  const tags = items.map((item) => describeFormat(item));
  const showSize = size !== "micro" && sizes.some((value) => value !== "");
  const showTag = size !== "micro" && tags.some((value) => value !== "");
  const sizeWidth = showSize ? Math.max(...sizes.map(displayWidth)) : 0;
  const tagWidth = showTag ? Math.max(...tags.map(displayWidth)) : 0;
  const reserved = indexWidth + sizeWidth + tagWidth + (showSize ? 2 : 0) + (showTag ? 2 : 0) + 4;
  const titleWidth = Math.max(12, columns - reserved);
  items.forEach((item, index) => {
    const number = c.muted(String(index + 1).padStart(indexWidth));
    const cells = [`  ${number}  ${c.text(fit(item.title, titleWidth))}`];
    if (showTag) cells.push(c.accent(fit(tags[index] ?? "", tagWidth)));
    if (showSize) cells.push(c.muted(fit(sizes[index] ?? "", sizeWidth)));
    ctx.logger.result(cells.join("  ").trimEnd());
  });
  ctx.logger.blank();
  ctx.logger.detail(
    `${items.length} item${items.length === 1 ? "" : "s"}  ${glyph.bullet}  download with: vectrax <url>`
  );
}

// src/cli/commands/tag.ts
import path15 from "path";
import { writeFile as writeFile5 } from "fs/promises";
function parseAssignments(assignments) {
  const metadata = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new UsageError(`--set expects "field=value" (got "${assignment}").`, {
        hint: `Editable fields: ${EDITABLE_FIELDS.join(", ")}.`
      });
    }
    const rawField = assignment.slice(0, separator).trim();
    const value = assignment.slice(separator + 1).trim();
    const field = EDITABLE_FIELDS.find((known) => known.toLowerCase() === rawField.toLowerCase());
    if (field === void 0) {
      throw new UsageError(`Unknown metadata field "${rawField}".`, {
        hint: `Editable fields: ${EDITABLE_FIELDS.join(", ")}.`
      });
    }
    if (NUMERIC_FIELDS.has(field)) {
      if (value === "") {
        Object.assign(metadata, { [field]: "" });
        continue;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new UsageError(`${FIELD_LABELS[field]} must be a non-negative number (got "${value}").`);
      }
      Object.assign(metadata, { [field]: parsed });
    } else {
      Object.assign(metadata, { [field]: value });
    }
  }
  return metadata;
}
async function runTag(ctx, files, options) {
  const updates = options.clear ? {} : parseAssignments(options.set ?? []);
  for (const file of files) {
    if (!await pathExists(file)) {
      throw new VectraxError(`No such file: ${file}`, {
        code: "E_FS",
        exitCode: ExitCode.FilesystemError
      });
    }
  }
  if (options.exportArtwork !== void 0) return exportArtwork(ctx, files, options.exportArtwork);
  const hasEdits = options.set !== void 0 && options.set.length > 0 || options.artwork !== void 0 || options.removeArtwork || options.clear;
  if (options.interactive) {
    if (files.length !== 1) {
      throw new UsageError("--interactive edits one file at a time.", {
        hint: "Pass a single file, or use --set for batch edits."
      });
    }
    return editInteractively(ctx, files[0], options);
  }
  if (!hasEdits) return showTags(ctx, files);
  return applyEdits(ctx, files, options, updates);
}
async function showTags(ctx, files) {
  const entries = await mapPool(
    files,
    async (file) => ({ file, metadata: await readTags(file) }),
    { limit: 4, signal: ctx.signal }
  );
  if (ctx.flags.json === true) {
    ctx.logger.resultJson(
      entries.map(
        (entry, index) => entry.status === "fulfilled" ? {
          file: entry.value.file,
          taggable: supportsTagging(entry.value.file),
          tags: serialise(entry.value.metadata)
        } : { file: files[index], error: errorMessage(entry.reason) }
      )
    );
    return ExitCode.Ok;
  }
  let failures = 0;
  entries.forEach((entry, index) => {
    if (entry.status === "rejected") {
      failures++;
      ctx.logger.error(`${files[index]}: ${errorMessage(entry.reason)}`);
      return;
    }
    if (files.length > 1) {
      ctx.logger.blank();
      ctx.logger.result(c.accent(path15.basename(entry.value.file)));
    }
    printTags(ctx, entry.value.metadata, entry.value.file);
  });
  return failures > 0 ? ExitCode.Failure : ExitCode.Ok;
}
function printTags(ctx, metadata, file) {
  if (isEmptyMetadata(metadata)) {
    ctx.logger.blank();
    ctx.logger.detail(
      supportsTagging(file) ? "No metadata present." : "This container does not support tags."
    );
    ctx.logger.blank();
    return;
  }
  ctx.logger.blank();
  const width = Math.max(...EDITABLE_FIELDS.map((field) => FIELD_LABELS[field].length));
  for (const field of EDITABLE_FIELDS) {
    const value = metadata[field];
    if (value === void 0 || value === "") continue;
    ctx.logger.result(`  ${c.muted(padEnd(FIELD_LABELS[field], width))}  ${c.text(String(value))}`);
  }
  if (metadata.sourceUrl !== void 0) {
    ctx.logger.result(`  ${c.muted(padEnd("Source", width))}  ${c.text(metadata.sourceUrl)}`);
  }
  if (metadata.artwork !== void 0) {
    const { mime, data } = metadata.artwork;
    ctx.logger.result(
      `  ${c.muted(padEnd("Artwork", width))}  ${c.accent(mime)} ${c.muted(`(${formatBytes(data.length)})`)}`
    );
  }
  ctx.logger.blank();
}
function serialise(metadata) {
  const { artwork, ...rest } = metadata;
  return {
    ...rest,
    artwork: artwork !== void 0 ? { mime: artwork.mime, bytes: artwork.data.length } : null
  };
}
async function applyEdits(ctx, files, options, updates) {
  const artwork = options.artwork !== void 0 ? await loadArtwork(ctx, options.artwork) : void 0;
  const results = await mapPool(
    files,
    async (file) => {
      const existing = options.clear ? {} : await readTags(file);
      let metadata = options.clear ? {} : mergeMetadata(existing, updates);
      if (options.removeArtwork) delete metadata.artwork;
      if (artwork !== void 0) metadata = { ...metadata, artwork };
      await writeTags(file, metadata);
      return metadata;
    },
    { limit: 4, signal: ctx.signal }
  );
  let updated = 0;
  let failed = 0;
  results.forEach((result, index) => {
    const file = files[index];
    if (result.status === "fulfilled") {
      updated++;
      if (ctx.flags.json !== true) {
        ctx.logger.success(`${path15.basename(file)} ${c.muted("updated")}`);
      }
    } else {
      failed++;
      ctx.logger.error(`${path15.basename(file)}: ${errorMessage(result.reason)}`);
    }
  });
  if (ctx.flags.json === true) {
    ctx.logger.resultJson({
      updated,
      failed,
      files: results.map((result, index) => ({
        file: files[index],
        ok: result.status === "fulfilled",
        ...result.status === "fulfilled" ? { tags: serialise(result.value) } : { error: errorMessage(result.reason) }
      }))
    });
  }
  return failed > 0 ? updated > 0 ? ExitCode.PartialFailure : ExitCode.Failure : ExitCode.Ok;
}
async function loadArtwork(ctx, source) {
  if (/^https?:\/\//i.test(source)) {
    const url = parseUrl(source, {
      allowPrivateHosts: ctx.config.allowPrivateHosts,
      allowInsecure: ctx.config.allowInsecure
    });
    const { data } = await ctx.http.buffer(url, {
      maxBytes: 16 * 1024 * 1024,
      ...ctx.signal !== void 0 ? { signal: ctx.signal } : {}
    });
    return toArtwork(data);
  }
  return readArtworkFile(source);
}
async function exportArtwork(ctx, files, target) {
  if (files.length !== 1) {
    throw new UsageError("--export-artwork works on one file at a time.");
  }
  const file = files[0];
  const metadata = await readTags(file);
  if (metadata.artwork === void 0) {
    throw new VectraxError(`${path15.basename(file)} has no embedded artwork.`, {
      code: "E_NO_MEDIA",
      exitCode: ExitCode.NoResults
    });
  }
  const destination = path15.extname(target) === "" ? `${target}${artworkExtension(metadata.artwork)}` : target;
  await writeFile5(destination, metadata.artwork.data);
  ctx.logger.success(
    `Artwork written to ${c.accent(destination)} ${c.muted(`(${formatBytes(metadata.artwork.data.length)})`)}`
  );
  return ExitCode.Ok;
}
async function editInteractively(ctx, file, options) {
  if (!isInteractiveSession() || ctx.flags.json === true) {
    throw new UsageError("--interactive requires a terminal.", {
      hint: "Use --set field=value to edit non-interactively."
    });
  }
  const original = await readTags(file);
  ctx.logger.blank();
  ctx.logger.result(c.accent(path15.basename(file)));
  printTags(ctx, original, file);
  ctx.logger.detail("Enter a new value, or press enter to keep the current one. Esc cancels.");
  ctx.logger.blank();
  const edited = { ...original };
  for (const field of EDITABLE_FIELDS) {
    const current = original[field];
    const answer = await text({
      message: padEnd(FIELD_LABELS[field], 13),
      initial: current !== void 0 ? String(current) : "",
      placeholder: current === void 0 ? c.muted("(empty)") : "",
      flag: `--set ${field}=\u2026`
    });
    const trimmed = answer.trim();
    if (trimmed === "") {
      delete edited[field];
      continue;
    }
    if (NUMERIC_FIELDS.has(field)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isFinite(parsed) && parsed >= 0) Object.assign(edited, { [field]: parsed });
    } else {
      Object.assign(edited, { [field]: trimmed });
    }
  }
  if (options.removeArtwork) delete edited.artwork;
  ctx.logger.blank();
  const changes = summariseChanges(original, edited);
  if (changes.length === 0) {
    ctx.logger.info("No changes.");
    return ExitCode.Ok;
  }
  ctx.logger.heading("changes");
  for (const change of changes) ctx.logger.result(`  ${change}`);
  ctx.logger.blank();
  if (!options.yes) {
    const proceed = await confirm({ message: `Write ${changes.length} change(s) to the file?`, initial: true, flag: "--yes" });
    if (!proceed) {
      ctx.logger.info("Cancelled \u2014 the file was not modified.");
      return ExitCode.Ok;
    }
  }
  await writeTags(file, edited);
  ctx.logger.success(`${path15.basename(file)} updated`);
  return ExitCode.Ok;
}
function summariseChanges(before, after) {
  const lines = [];
  for (const field of EDITABLE_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (String(from ?? "") === String(to ?? "")) continue;
    const label = c.muted(padEnd(FIELD_LABELS[field], 13));
    const oldValue = from === void 0 ? c.muted("(empty)") : c.danger(truncate(String(from), 30));
    const newValue = to === void 0 ? c.muted("(cleared)") : c.success(truncate(String(to), 30));
    lines.push(`${label} ${oldValue} ${c.muted(glyph.arrow)} ${newValue}`);
  }
  return lines;
}

// src/cli/commands/config.ts
async function runConfigList(ctx) {
  const file = configFilePath();
  const fileValues = await readConfigFile(file);
  const envValues = configFromEnv();
  const effective = await resolveConfig();
  if (ctx.flags.json === true) {
    ctx.logger.resultJson({ file, effective, sources: originMap(fileValues, envValues) });
    return ExitCode.Ok;
  }
  ctx.logger.blank();
  ctx.logger.detail(`config file: ${file}`);
  ctx.logger.blank();
  const keyWidth = Math.max(...CONFIG_KEYS.map((key) => key.length));
  const origins = originMap(fileValues, envValues);
  const valueWidth = Math.max(20, Math.min(48, ctx.logger.columns - keyWidth - 16));
  for (const key of CONFIG_KEYS) {
    const origin = origins[key];
    const value = truncate(format(effective[key]), valueWidth);
    const badge = origin === "env" ? c.warn("env") : origin === "file" ? c.accent("file") : c.muted("default");
    ctx.logger.result(`  ${c.muted(padEnd(key, keyWidth))}  ${c.text(padEnd(value, valueWidth))}  ${badge}`);
  }
  ctx.logger.blank();
  ctx.logger.detail(`set with: vectrax config set <key> <value>  ${glyph.bullet}  env: ${envNameFor("outputDir")}=\u2026`);
  return ExitCode.Ok;
}
async function runConfigGet(ctx, key) {
  assertKnownKey(key);
  const effective = await resolveConfig();
  const value = effective[key];
  ctx.logger.result(ctx.flags.json === true ? JSON.stringify(value) : format(value));
  return ExitCode.Ok;
}
async function runConfigSet(ctx, key, value) {
  assertKnownKey(key);
  const parsed = parseConfigValue(key, value);
  const file = configFilePath();
  const current = await readConfigFile(file);
  await writeConfigFile({ ...current, [key]: parsed }, file);
  ctx.logger.success(`${c.accent(key)} = ${c.text(format(parsed))}`);
  ctx.logger.detail(file);
  return ExitCode.Ok;
}
async function runConfigUnset(ctx, key) {
  assertKnownKey(key);
  const file = configFilePath();
  const current = await readConfigFile(file);
  if (!(key in current)) {
    ctx.logger.info(`${key} is not set in the config file; it already uses the default.`);
    return ExitCode.Ok;
  }
  const { [key]: _removed, ...rest } = current;
  await writeConfigFile(rest, file);
  ctx.logger.success(`Removed ${c.accent(key)} \u2014 reverted to the default.`);
  return ExitCode.Ok;
}
function runConfigPath(ctx) {
  ctx.logger.result(configFilePath());
  return ExitCode.Ok;
}
function assertKnownKey(key) {
  if (!CONFIG_KEYS.includes(key)) {
    throw new ConfigError(`Unknown config key "${key}".`, {
      hint: `Valid keys: ${CONFIG_KEYS.join(", ")}.`
    });
  }
}
function originMap(fileValues, envValues) {
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => [
      key,
      key in envValues ? "env" : key in fileValues ? "file" : "default"
    ])
  );
}
function format(value) {
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

// src/cli/program.ts
var advancedRequested = () => process.argv.includes("--advanced");
function advanced(option) {
  return advancedRequested() ? option : option.hideHelp();
}
function withEssentialOptions(command) {
  return command.addOption(new Option("-o, --output <dir>", "where to save files")).addOption(
    new Option("-q, --quality <level>", "best | high | balanced | small, or 320k / 1080p").default(
      "balanced"
    )
  ).addOption(new Option("-a, --audio", "prefer audio")).addOption(new Option("-v, --video", "prefer video")).addOption(
    new Option("-f, --format <format>", "mp3, m4a, flac, wav, opus, mp4, mkv, webm \u2014 or compatible / archive")
  );
}
function withAdvancedOptions(command) {
  return command.addOption(advanced(new Option("--select <expr>", "select by index, e.g. 1,3,5-8"))).addOption(advanced(new Option("--limit <n>", "cap items taken from a playlist").argParser((v) => parseInteger("--limit", v, 1, 1e3)))).addOption(advanced(new Option("--kind <kinds...>", "media categories to match").choices([...MEDIA_KINDS]).argParser(collect))).addOption(advanced(new Option("--ext <extensions>", "extra file extensions to accept").argParser(collect))).addOption(advanced(new Option("--match <pattern>", "keep only items matching this regex"))).addOption(advanced(new Option("--sizes", "fetch sizes before selecting"))).addOption(advanced(new Option("--concurrency <n>", "simultaneous transfers (1-16)").argParser((v) => parseInteger("--concurrency", v, 1, 16)))).addOption(advanced(new Option("--retries <n>", "retry attempts per file (0-10)").argParser((v) => parseInteger("--retries", v, 0, 10)))).addOption(advanced(new Option("--timeout <ms>", "response-header timeout").argParser((v) => parseInteger("--timeout", v, 1e3, 6e5)))).addOption(advanced(new Option("--referer <value>", "Referer header: auto, none, or a URL"))).addOption(advanced(new Option("--user-agent <value>", "User-Agent header"))).addOption(advanced(new Option("--conflict <policy>", "when a filename is taken").choices(["rename", "skip", "overwrite"]))).addOption(advanced(new Option("--no-resume", "ignore partial files from a previous run"))).addOption(advanced(new Option("--allow-private", "permit private or loopback addresses"))).addOption(advanced(new Option("--no-insecure", "refuse plaintext http:// URLs")));
}
function overridesFrom(flags) {
  const overrides = {};
  const set = (key, value) => {
    if (value !== void 0) overrides[key] = value;
  };
  set("outputDir", flags["output"]);
  set("concurrency", flags["concurrency"]);
  set("retries", flags["retries"]);
  set("timeoutMs", flags["timeout"]);
  set("referer", flags["referer"]);
  set("userAgent", flags["userAgent"]);
  set("conflict", flags["conflict"]);
  if (flags["resume"] === false) overrides.resume = false;
  if (flags["allowPrivate"] === true) overrides.allowPrivateHosts = true;
  if (flags["insecure"] === false) overrides.allowInsecure = false;
  if (flags["fallback"] === false) overrides.fallback = false;
  const kind = flags["kind"];
  if (kind !== void 0 && kind.length > 0) overrides.kinds = parseKinds(kind);
  return overrides;
}
function mediaIntentFrom(flags) {
  if (flags["video"] === true) return "video";
  if (flags["audio"] === true) return "audio";
  return "auto";
}
function formatFrom(flags) {
  const value = flags["format"];
  return typeof value === "string" ? parseFormat(value) : KEEP_ORIGINAL;
}
function qualityFrom(flags) {
  const value = flags["quality"];
  return typeof value === "string" ? parseQuality(value) : DEFAULT_QUALITY;
}
function discoveryFrom(flags) {
  const kind = flags["kind"];
  const ext = flags["ext"];
  const match = flags["match"];
  return {
    kinds: kind !== void 0 && kind.length > 0 ? parseKinds(kind) : void 0,
    extensions: ext !== void 0 ? parseExtensions(ext) : void 0,
    match: typeof match === "string" ? parseRegex("--match", match) : void 0,
    media: mediaIntentFrom(flags),
    quality: qualityFrom(flags),
    limit: typeof flags["limit"] === "number" ? flags["limit"] : void 0,
    sizes: flags["sizes"] === true
  };
}
function buildProgram() {
  const program = new Command();
  program.name("vectrax").description("Extract and download media from YouTube or any page.").version(VERSION, "-V, --version", "print the version").option("--json", "emit machine-readable JSON").option("--quiet", "only report errors").option("--verbose", "include debug diagnostics").option("--advanced", "show every option in help").addOption(new Option("--no-banner", "suppress the banner").hideHelp(!advancedRequested())).addOption(new Option("--config <file>", "use an alternate config file").hideHelp(!advancedRequested())).showHelpAfterError("(run `vectrax --help` for usage)").configureHelp({ sortSubcommands: false, sortOptions: false });
  program.addHelpText(
    "beforeAll",
    () => shouldShowBanner({ ...globalFlags(program), stream: process.stdout }) ? renderBanner({ version: VERSION }) : ""
  );
  program.addHelpText("after", helpFooter());
  const get = withAdvancedOptions(
    withEssentialOptions(
      new Command("get").alias("dl").description("download media from a link").argument("<url>", "page, video, track, or playlist link")
    )
  ).addOption(new Option("--all", "take everything without asking")).addOption(new Option("-y, --yes", "skip confirmation prompts")).addOption(advanced(new Option("-n, --dry-run", "resolve and report without downloading"))).addOption(advanced(new Option("--move <dir>", "move completed files here afterwards"))).addOption(advanced(new Option("--no-tag", "do not write metadata into downloaded files"))).addOption(advanced(new Option("--no-artwork", "do not embed cover art"))).addOption(advanced(new Option("--no-fallback", "do not retry failures with yt-dlp"))).addOption(advanced(new Option("--install-fallback", "allow installing yt-dlp without asking"))).action(async (url, flags) => {
    await run2(
      program,
      overridesFrom(flags),
      async (ctx) => runGet(ctx, url, {
        ...discoveryFrom(flags),
        all: flags["all"] === true,
        select: typeof flags["select"] === "string" ? flags["select"] : void 0,
        yes: flags["yes"] === true,
        dryRun: flags["dryRun"] === true,
        move: typeof flags["move"] === "string" ? flags["move"] : void 0,
        tag: flags["tag"] !== false,
        artwork: flags["artwork"] !== false,
        fallback: flags["fallback"] !== false,
        installFallback: flags["installFallback"] === true,
        format: formatFrom(flags)
      })
    );
  });
  const scan = withAdvancedOptions(
    withEssentialOptions(
      new Command("scan").alias("ls").description("list what a link offers, without downloading").argument("<url>", "page, video, track, or playlist link")
    )
  ).action(async (url, flags) => {
    await run2(program, overridesFrom(flags), async (ctx) => runScan(ctx, url, discoveryFrom(flags)));
  });
  const tag = new Command("tag").description("view and edit audio metadata").argument("<files...>", "audio files to inspect or edit").option("-s, --set <assignment...>", 'set a field, e.g. --set artist="Nina Simone"', collect).option("-i, --interactive", "edit fields one by one").option("--artwork <source>", "embed cover art from a path or URL").addOption(advanced(new Option("--remove-artwork", "strip embedded cover art"))).addOption(advanced(new Option("--export-artwork <file>", "write embedded cover art to a file"))).addOption(advanced(new Option("--clear", "remove all metadata"))).option("-y, --yes", "skip confirmation prompts").addHelpText("after", `
${c.accent("Fields")}
  ${EDITABLE_FIELDS.join(", ")}
`).action(async (files, flags) => {
    await run2(
      program,
      {},
      async (ctx) => runTag(ctx, files, {
        set: Array.isArray(flags["set"]) ? flags["set"] : void 0,
        artwork: typeof flags["artwork"] === "string" ? flags["artwork"] : void 0,
        removeArtwork: flags["removeArtwork"] === true,
        exportArtwork: typeof flags["exportArtwork"] === "string" ? flags["exportArtwork"] : void 0,
        clear: flags["clear"] === true,
        interactive: flags["interactive"] === true,
        yes: flags["yes"] === true
      })
    );
  });
  const config = new Command("config").description("view and edit saved settings");
  config.command("list", { isDefault: true }).description("show the effective configuration").action(async () => {
    await run2(program, {}, runConfigList);
  });
  config.command("get <key>").description("print a single value").action(async (key) => {
    await run2(program, {}, async (ctx) => runConfigGet(ctx, key));
  });
  config.command("set <key> <value>").description("save a value").action(async (key, value) => {
    await run2(program, {}, async (ctx) => runConfigSet(ctx, key, value));
  });
  config.command("unset <key>").description("revert a value to its default").action(async (key) => {
    await run2(program, {}, async (ctx) => runConfigUnset(ctx, key));
  });
  config.command("path").description("print the config file location").action(async () => {
    await run2(program, {}, async (ctx) => runConfigPath(ctx));
  });
  program.addCommand(get, { isDefault: true });
  program.addCommand(scan);
  program.addCommand(tag);
  program.addCommand(config);
  return program;
}
function helpFooter() {
  const example = (command, note) => `  ${c.muted("$")} ${command.padEnd(49)}${c.muted(note)}`;
  const base = [
    "",
    c.accent("Examples"),
    example("vectrax https://youtu.be/dQw4w9WgXcQ", "a song, tagged"),
    example("vectrax <playlist-url> --all", "a whole playlist"),
    example("vectrax <url> --video --quality 1080p", "video instead"),
    example("vectrax <url> --quality best", "maximum quality"),
    example("vectrax <url> --format mp3", "convert after downloading"),
    example("vectrax scan <url>", "look before downloading"),
    example('vectrax tag song.mp3 --set artist="Nina Simone"', "edit metadata"),
    "",
    `${c.muted("Vectrax picks the source, format, and quality for you. Interrupted transfers resume.")}`
  ];
  if (!advancedRequested()) {
    base.push(`${c.muted("Run")} vectrax --advanced --help ${c.muted("to see every option.")}`);
  }
  return `${base.join("\n")}
`;
}
function globalFlags(program) {
  const opts = program.opts();
  return {
    json: opts.json === true,
    quiet: opts.quiet === true,
    noBanner: opts.banner === false,
    ...opts.verbose !== void 0 ? { verbose: opts.verbose } : {},
    ...opts.config !== void 0 ? { config: opts.config } : {}
  };
}
async function run2(program, overrides, handler) {
  const flags = globalFlags(program);
  if (shouldShowBanner(flags)) await playBannerReaction({ version: VERSION });
  const { controller, dispose } = createInterruptController();
  try {
    const ctx = await createContext({ flags, overrides, signal: controller.signal });
    process.exitCode = await handler(ctx);
  } finally {
    dispose();
  }
  if (controller.signal.aborted && (process.exitCode ?? 0) === ExitCode.Ok) {
    process.exitCode = ExitCode.Interrupted;
  }
}

// src/bin/vectrax.ts
function restoreTerminal() {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  if (process.stderr.isTTY) process.stderr.write(ansi.showCursor);
}
function reportError(error) {
  restoreTerminal();
  if (isAbortError(error)) {
    process.stderr.write(`
${c.warn(glyph.warn)} ${c.text("Interrupted.")} ${c.muted("Partial downloads were kept \u2014 re-run to resume.")}
`);
    return ExitCode.Interrupted;
  }
  if (isVectraxError(error)) {
    process.stderr.write(`
${c.danger(glyph.cross)} ${c.text(error.message)}
`);
    if (error.hint !== void 0) {
      process.stderr.write(`  ${c.muted(error.hint)}
`);
    }
    if (process.env["VECTRAX_DEBUG"] !== void 0 && error.stack !== void 0) {
      process.stderr.write(`${c.muted(error.stack)}
`);
    }
    return error.exitCode;
  }
  process.stderr.write(`
${c.danger(glyph.cross)} ${c.text("Unexpected error.")} ${c.muted("This is a bug in Vectrax.")}
`);
  process.stderr.write(`${c.muted(error instanceof Error ? error.stack ?? error.message : errorMessage(error))}
`);
  return ExitCode.Failure;
}
async function main() {
  process.on("exit", restoreTerminal);
  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(ExitCode.Ok);
  });
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? ExitCode.Ok : ExitCode.UsageError;
      return;
    }
    process.exitCode = reportError(error);
  }
}
await main();
//# sourceMappingURL=vectrax.js.map