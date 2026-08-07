// src/core/http/client.ts
import { setTimeout as sleep } from "timers/promises";

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

// src/core/http/guard.ts
import { isIP } from "net";
var ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function parseUrl(input, options = {}) {
  const trimmed = input.trim();
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
    throw new VectraxError(`Not a valid URL: ${input}`, {
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
          await sleep(delayMs, void 0, { signal: options.signal });
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
        await sleep(delayMs, void 0, { signal: options.signal });
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
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new NetworkError(`Expected JSON from ${url.host} but got something else.`, {
        hint: "The service may be rate-limiting or returning an error page.",
        details: { url: url.href, preview: text.slice(0, 120) },
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

// src/core/scrape/extract.ts
import path from "path";

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
function detectQuality(...sources) {
  for (const source of sources) {
    if (source === void 0 || source === "") continue;
    for (const { pattern, format } of QUALITY_PATTERNS) {
      const match = pattern.exec(source);
      if (match !== null) return format(match);
    }
  }
  return void 0;
}

// src/core/scrape/extract.ts
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
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\\//g, "/").replace(/\\"/g, '"');
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
  const ext = path.extname(pathname).slice(1).toLowerCase();
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
    const text = textContent(match[2] ?? "");
    const title = firstNonEmpty(text, attribute(attributes, "download"), attribute(attributes, "title"), attribute(attributes, "aria-label"));
    raw.push({ href, title, source: "anchor", titleRank: text !== "" ? 4 : 3 });
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
  const stem = path.basename(segment, path.extname(segment)).replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
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
  const segment = decodeSafe(url.pathname.split("/").filter(Boolean).pop() ?? "download");
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
function decodeSafe(value) {
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

// src/core/quality.ts
var QUALITY_PRESETS = ["best", "high", "balanced", "small"];
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
function parseQuality(input) {
  const value = input.trim().toLowerCase();
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
  throw new UsageError(`Unrecognised quality "${input}".`, {
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
function extensionFor(format) {
  const mime = format.mimeType ?? "";
  if (mime.includes("audio/mp4")) return "m4a";
  if (mime.includes("audio/webm")) return "webm";
  if (mime.includes("video/mp4")) return "mp4";
  if (mime.includes("video/webm")) return "webm";
  return "bin";
}
var TAGGABLE_AUDIO = "m4a";
var AUDIO_OVERSHOOT = 1.2;
function audioKbps(format) {
  return Math.round((format.bitrate ?? 0) / 1e3);
}
function selectAudio(formats, targets) {
  const audio = formats.filter((format) => format.mimeType?.startsWith("audio/") === true);
  if (audio.length === 0) return void 0;
  const choice = chooseByCeiling(audio, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);
  if (choice === void 0) return void 0;
  if (extensionFor(choice.item) === TAGGABLE_AUDIO) {
    return { format: choice.item, note: describeShortfall(choice, "kbps", "YouTube") };
  }
  const taggable = audio.filter((format) => extensionFor(format) === TAGGABLE_AUDIO);
  const preferred = chooseByCeiling(taggable, audioKbps, targets.audioKbps, AUDIO_OVERSHOOT);
  if (preferred !== void 0 && preferred.satisfied) {
    return { format: preferred.item, note: describeShortfall(preferred, "kbps", "YouTube") };
  }
  return { format: choice.item, note: describeShortfall(choice, "kbps", "YouTube") };
}
function selectVideo(formats, targets) {
  const muxed = formats.filter(
    (format) => format.mimeType?.startsWith("video/") === true && format.audioQuality !== void 0
  );
  if (muxed.length === 0) return void 0;
  const choice = chooseByCeiling(muxed, (format) => format.height ?? 0, targets.videoHeight);
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
  const usable = formats.filter((format) => typeof format.url === "string" && format.url !== "");
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
    const text = runs.map((run2) => run2["text"]).filter((t) => typeof t === "string").join("");
    return text === "" ? void 0 : text;
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
    (format) => format.mimeType?.startsWith("video/") === true && format.audioQuality !== void 0 && typeof format.url === "string"
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
    filename: buildFilename(metadata, displayTitle),
    ...Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {},
    ...Number.isFinite(size) && size > 0 ? { size } : {}
  };
}
function buildFilename(metadata, fallback) {
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

// src/core/metadata/tags.ts
import { readFile, rename as rename2, writeFile, stat as stat2 } from "fs/promises";
import path3 from "path";

// src/core/util/fs.ts
import { constants } from "fs";
import { access, mkdir, rename, copyFile, unlink, stat } from "fs/promises";
import path2 from "path";
import os from "os";
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
  const text = () => payload.toString("utf8").replace(/\u0000+$/, "");
  switch (type) {
    case "\xA9nam":
      metadata.title = text();
      return;
    case "\xA9ART":
      metadata.artist = text();
      return;
    case "\xA9alb":
      metadata.album = text();
      return;
    case "aART":
      metadata.albumArtist = text();
      return;
    case "\xA9gen":
      metadata.genre = text();
      return;
    case "\xA9wrt":
      metadata.composer = text();
      return;
    case "\xA9cmt":
      metadata.comment = text();
      return;
    case "\xA9day": {
      const year = Number.parseInt(text().slice(0, 4), 10);
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
  return path3.extname(filename).toLowerCase() in EXTENSION_FORMATS;
}
function detectFormat(buffer, filename) {
  if (isFlac(buffer)) return "flac";
  if (isMp4(buffer)) return "mp4";
  if (findId3Tag(buffer) !== void 0) return "id3";
  if (buffer.length > 2 && buffer[0] === 255 && (buffer[1] & 224) === 224) return "id3";
  return EXTENSION_FORMATS[path3.extname(filename).toLowerCase()];
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
      throw new VectraxError(`Cannot tag ${path3.basename(filename)}: unrecognised audio container.`, {
        code: "E_USAGE",
        hint: `Supported formats: ${[...new Set(Object.keys(EXTENSION_FORMATS))].join(", ")}.`
      });
  }
}
var MAX_TAG_FILE_BYTES = 512 * 1024 * 1024;
async function readTags(file) {
  let buffer;
  try {
    buffer = await readFile(file);
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
    throw new FilesystemError(`Refusing to tag ${path3.basename(file)}: file is larger than 512 MB.`, {
      hint: "Tagging rewrites the container in memory."
    });
  }
  const buffer = await readFile(file).catch((error) => {
    throw wrapFsError(error, "read file", file);
  });
  const updated = writeTagsToBuffer(buffer, file, metadata);
  const staging = `${file}.vxtag`;
  try {
    await writeFile(staging, updated);
    await rename2(staging, file);
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
    return toArtwork(await readFile(file), path3.basename(file));
  } catch (error) {
    if (error instanceof VectraxError) throw error;
    throw new FilesystemError(`Cannot read artwork file: ${file} (${errorMessage(error)})`, { cause: error });
  }
}

// src/core/metadata/embed.ts
import path4 from "path";

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
      warnings.push(`${path4.basename(job.path)}: ${errorMessage(result.reason)}`);
    }
  });
  return { tagged, skipped, warnings };
}

// src/core/download/engine.ts
import { createWriteStream } from "fs";
import { readFile as readFile2, writeFile as writeFile2, rename as rename3, truncate as truncateFile } from "fs/promises";
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
function sanitizeFilename(input, fallback = "download") {
  let name = path5.basename(input.replace(/[\\/]+/g, "/"));
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
  const ext = path5.extname(decodeSafe2(url.pathname)).toLowerCase();
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
    const decoded = decodeSafe2(raw);
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
function decodeSafe2(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function titleFromUrl(url) {
  const segment = decodeSafe2(url.pathname).split("/").filter(Boolean).pop();
  if (segment === void 0) return void 0;
  const stem = path5.basename(segment, path5.extname(segment));
  const pretty = stem.replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim();
  return pretty.length >= 2 ? pretty : void 0;
}
function buildFilename2(options) {
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
      const filename = buildFilename2({
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
      await rename3(partPath, destination);
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
var displayWidth = (text) => stringWidth(text);
function truncate(text, maxWidth, ellipsis = "\u2026") {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let width = 0;
  let out = "";
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > budget) break;
    width += charWidth;
    out += char;
  }
  return out + ellipsis;
}
function padEnd(text, width) {
  const delta = width - displayWidth(text);
  return delta > 0 ? text + " ".repeat(delta) : text;
}
function padStart(text, width) {
  const delta = width - displayWidth(text);
  return delta > 0 ? " ".repeat(delta) + text : text;
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

// src/config/schema.ts
import { z } from "zod";

// src/core/util/platform.ts
import { access as access2, constants as constants2 } from "fs/promises";
import os2 from "os";
import path7 from "path";
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
  const entries = (process.env["PATH"] ?? "").split(path7.delimiter).filter(Boolean);
  const extensions = executableExtensions();
  const hasExtension = path7.extname(name) !== "";
  for (const entry of entries) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = path7.join(entry, `${name}${extension}`);
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
  if (override !== void 0 && override !== "") return path7.resolve(override);
  if (isWindows()) {
    const base = windowsAppData("roaming") ?? path7.join(os2.homedir(), "AppData", "Roaming");
    return path7.join(base, "Vectrax");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== void 0 && xdg !== "") return path7.join(xdg, "vectrax");
  if (platform() === "macos") {
    return path7.join(os2.homedir(), "Library", "Application Support", "Vectrax");
  }
  return path7.join(os2.homedir(), ".config", "vectrax");
}
function dataDirectory() {
  const override = process.env["VECTRAX_DATA_DIR"];
  if (override !== void 0 && override !== "") return path7.resolve(override);
  if (isWindows()) {
    const base = windowsAppData("local") ?? path7.join(os2.homedir(), "AppData", "Local");
    return path7.join(base, "Vectrax");
  }
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg !== void 0 && xdg !== "") return path7.join(xdg, "vectrax");
  if (platform() === "macos") {
    return path7.join(os2.homedir(), "Library", "Application Support", "Vectrax");
  }
  return path7.join(os2.homedir(), ".local", "share", "vectrax");
}
function toolsDirectory() {
  return path7.join(dataDirectory(), "tools");
}
function defaultDownloadDirectory() {
  return path7.join(os2.homedir(), "Downloads", "Vectrax");
}

// src/config/schema.ts
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
import { readFile as readFile3, writeFile as writeFile3 } from "fs/promises";
import path8 from "path";
import "zod";
function configFilePath() {
  return path8.join(configDirectory(), "config.json");
}
async function readConfigFile(file = configFilePath()) {
  if (!await pathExists(file)) return {};
  let raw;
  try {
    raw = await readFile3(file, "utf8");
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
function formatIssues(error) {
  return error.issues.map((issue) => {
    const field = issue.path.join(".");
    return field === "" ? issue.message : `  ${field}: ${issue.message}`;
  }).join("\n");
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
}

// src/core/fallback/ytdlp.ts
import { spawn } from "child_process";
import path9 from "path";
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
  const managed = path9.join(toolsDirectory(), isWindows() ? `${binary}.exe` : binary);
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
  return path9.join(outputDir, `${stem}.%(ext)s`);
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
          new VectraxError(`${path9.basename(tool.binary)} timed out.`, {
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
      const text = chunk.toString("utf8");
      stderr += text;
      pending += text;
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
          new VectraxError(`Could not run ${path9.basename(tool.binary)}: ${error.message}`, {
            code: "E_INTERNAL",
            exitCode: ExitCode.Failure
          })
        )
      );
    });
    child.on("close", (code) => {
      finish(() => {
        const produced = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "" && path9.isAbsolute(line));
        const file = produced[produced.length - 1];
        if (code !== 0 || file === void 0) {
          reject(
            new VectraxError(
              `${path9.basename(tool.binary)} could not download this item.`,
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
function parseFormat(input) {
  const value = input.trim().toLowerCase();
  if (value === "original" || value === "source" || value === "keep") return KEEP_ORIGINAL;
  if (value === "compatible" || value === "phone" || value === "universal") {
    return { intent: "compatible", audio: "mp3", video: "mp4" };
  }
  if (value === "archive" || value === "lossless") {
    return { intent: "archive", audio: "flac", video: "mkv" };
  }
  const format = ALIASES[value];
  if (format === void 0) {
    throw new UsageError(`Unrecognised format "${input}".`, {
      hint: `Audio: ${AUDIO_FORMATS.join(", ")}. Video: ${VIDEO_FORMATS.join(", ")}. Or use original, compatible, archive.`
    });
  }
  return isAudioFormat(format) ? { intent: "original", audio: format, video: void 0 } : { intent: "original", audio: void 0, video: format };
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

// src/core/convert/ffmpeg.ts
import { spawn as spawn2 } from "child_process";
import { rename as rename4, stat as stat3 } from "fs/promises";
import path10 from "path";
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
function run(command, args, signal, onLine) {
  return new Promise((resolve2, reject) => {
    const child = spawn2(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
      const text = chunk.toString("utf8");
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== "") onLine?.(line.trim());
      }
    });
    child.on("error", (error) => {
      finish(() => reject(new VectraxError(`Could not run ${path10.basename(command)}: ${error.message}`)));
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
  const extension = path10.extname(file).slice(1).toLowerCase();
  if (tools.ffprobe === void 0) {
    return { extension, audioCodec: void 0, videoCodec: void 0, audioBitrate: void 0 };
  }
  const output = await run(
    tools.ffprobe,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    signal
  ).catch(() => "");
  let parsed = {};
  try {
    parsed = JSON.parse(output);
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
  const destination = path10.join(path10.dirname(source), `${path10.basename(source, path10.extname(source))}.${target}`);
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
    await rename4(staging, destination);
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

// src/version.ts
import { readFileSync } from "fs";
import path11 from "path";
import { fileURLToPath } from "url";
function readVersion() {
  let dir = path11.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(path11.join(dir, "package.json"), "utf8"));
      if (manifest.name === "vectrax" && manifest.version !== void 0) return manifest.version;
    } catch {
    }
    const parent = path11.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
var VERSION = readVersion();
export {
  AUDIO_FORMATS,
  CancelledError,
  ConfigError,
  DEFAULT_QUALITY,
  DEFAULT_USER_AGENT,
  DownloadEngine,
  EDITABLE_FIELDS,
  ExitCode,
  FIELD_LABELS,
  FilesystemError,
  HttpClient,
  HttpError,
  KEEP_ORIGINAL,
  MEDIA_KINDS,
  NetworkError,
  QUALITY_PRESETS,
  UsageError,
  VERSION,
  VIDEO_FORMATS,
  VectraxError,
  applyMetadata,
  artworkExtension,
  assertUrlAllowed,
  buildFilename2 as buildFilename,
  chooseByCeiling,
  collapseDuplicateQualities,
  computeBackoff,
  configFilePath,
  configSchema,
  convertFile,
  decodeBody,
  decodeEntities,
  detectFallbackTool,
  detectFormat,
  detectImageMime,
  detectQuality,
  detectToolchain,
  discover,
  displayWidth,
  extensionsForKinds,
  extractMedia,
  extractPageTitle,
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
  formatRate,
  formatSelector,
  isEmptyMetadata,
  isPrivateHost,
  isVectraxError,
  kindForExtension,
  mapPool,
  mergeMetadata,
  normalizeUrl,
  padEnd,
  padStart,
  pageProvider,
  parseFormat,
  parseQuality,
  parseUrl,
  parseYouTubeUrl,
  planConversion,
  pluralize,
  probeSizes,
  probeSource,
  providerFor,
  providerIds,
  providers,
  readArtworkFile,
  readFlac,
  readId3,
  readMp4,
  readTags,
  readTagsFromBuffer,
  renderBar,
  resolveConfig,
  runFallback,
  sanitizeFilename,
  selectFormat,
  splitArtistTitle,
  supportsTagging,
  targetFormatFor,
  toArtwork,
  truncate,
  unsupportedProvider,
  writeFlac,
  writeId3,
  writeMp4,
  writeTags,
  writeTagsToBuffer,
  youtubeProvider
};
//# sourceMappingURL=index.js.map