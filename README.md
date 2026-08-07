<div align="center">

```
██╗   ██╗███████╗ ██████╗████████╗██████╗  █████╗ ██╗  ██╗
██║   ██║██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚██╗██╔╝
██║   ██║█████╗  ██║        ██║   ██████╔╝███████║ ╚███╔╝
╚██╗ ██╔╝██╔══╝  ██║        ██║   ██╔══██╗██╔══██║ ██╔██╗
 ╚████╔╝ ███████╗╚██████╗   ██║   ██║  ██║██║  ██║██╔╝ ██╗
  ╚═══╝  ╚══════╝ ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬───⌬
```

**volatile media extraction**

</div>

Give Vectrax a link. It works out where the media is, picks a sensible format
and quality, downloads it concurrently and resumably, and writes proper
metadata and cover art into the file. When something it needs is missing, it
says so, asks, and fixes it for you.

---

## Install

```bash
npm install && npm run build && npm link
```

Requires Node.js 20.11 or newer. During development, `npm run dev -- <url>`.

## Use it

```bash
vectrax https://youtu.be/dQw4w9WgXcQ          # a song, tagged
vectrax <playlist-url> --all                  # a whole playlist
vectrax https://example.com/album             # any page: pick with the keyboard
vectrax <url> --format mp3                    # convert after downloading
```

There is no source flag. Vectrax recognises the link and does the right thing.

## The five options that matter

| Flag | What it does |
| --- | --- |
| `-o, --output <dir>` | Where to save |
| `-q, --quality <level>` | `best`, `high`, `balanced`, `small`, or an exact `320k` / `1080p` |
| `-a, --audio` | Prefer audio |
| `-v, --video` | Prefer video |
| `-f, --format <fmt>` | Output format, or `compatible` / `archive` |
| `--all` / `-y, --yes` | Take everything / skip prompts |

Everything else is hidden. `vectrax --advanced --help` reveals the full set —
selection expressions, concurrency, retries, timeouts, referer and user-agent,
conflict policy, resume control, private-address access, and more. They all
still work; they just don't clutter the common path.

### Quality

Vectrax detects what a source actually offers and picks the closest match to
your intent, preferring a taggable container when the difference is marginal.

- `best` — the maximum available
- `high` — 320 kbps / 1080p
- `balanced` *(default)* — 256 kbps / 720p
- `small` — 128 kbps / 480p
- exact — `128k`, `192k`, `256k`, `320k`, `360p`, `480p`, `720p`, `1080p`, `1440p`, `4k`

When a request cannot be met, Vectrax says so rather than silently substituting:
*"360p is the highest YouTube serves with audio included."*

On a page offering the same track at several bitrates, `--all` keeps one copy —
the one matching your quality intent — instead of downloading both.

## Formats

Vectrax keeps whatever the source gave you unless you ask otherwise — that is
always the highest-fidelity choice. When you do ask, it works out the cheapest
correct path.

```bash
vectrax <url> --format mp3          # widely compatible
vectrax <url> --format flac         # lossless container
vectrax <url> --format compatible   # mp3 for audio, mp4 for video
vectrax <url> --format archive      # flac for audio, mkv for video
```

Audio: `mp3`, `m4a`, `flac`, `wav`, `opus`, `ogg`. Video: `mp4`, `mkv`, `webm`.

**Remux before re-encode.** If the source codec already fits the target
container — AAC into `mp4`, Opus into `ogg` — Vectrax copies the stream rather
than decoding it. That is instant and bit-exact. Only a genuine codec change
triggers a re-encode, and then the source bitrate is carried across rather than
inflated.

**It tells you what a conversion costs.** Re-encoding lossy audio warns that
quality is lost. Asking for FLAC from a lossy source warns that the file will be
larger *without recovering anything* — Vectrax will still do it, but it won't
pretend.

Conversion is atomic: ffmpeg writes to a staging file that is renamed into place
only on success. Metadata and artwork are applied by Vectrax's own tagger
afterwards, so they survive the container change intact. For containers the
tagger doesn't support (`wav`, `opus`), clean metadata is written by ffmpeg
instead — artwork is not available there.

Conversion needs ffmpeg. Without it, files are kept as downloaded and Vectrax
says so.

## Metadata

Downloads are tagged automatically, cover art included. `--no-tag` opts out.

```bash
vectrax tag song.mp3                                  # show
vectrax tag song.mp3 --set artist="Nina Simone" --set year=1965
vectrax tag album/*.flac --set album="Pastel Blues"   # batch
vectrax tag song.m4a --interactive                    # field-by-field editor
vectrax tag song.mp3 --artwork cover.jpg
```

Fields: `title`, `artist`, `album`, `albumArtist`, `genre`, `year`, `track`,
`trackTotal`, `disc`, `discTotal`, `composer`, `comment`. `--set field=` clears.

| Container | Tags | Artwork |
| --- | --- | --- |
| `.mp3`, `.aac` | ID3v2.4 (reads 2.2/2.3/2.4) | `APIC` |
| `.flac` | Vorbis comments | `PICTURE` |
| `.m4a`, `.mp4`, `.m4b` | iTunes `ilst` atoms | `covr` |

Containers are detected by content, not extension — downloaded files are
routinely misnamed. Writes are atomic: staged beside the original, renamed into
place, so an interrupted write cannot truncate your music.

MP4 needs care the others don't. Its tags live in `moov`, which usually sits
*before* the audio, so resizing them shifts every byte of `mdat` and invalidates
the absolute chunk offsets in each track's `stco`/`co64` table. Vectrax repairs
those tables. Skipping that step yields a file that looks correct to a tag
reader and is unplayable. Tests assert the recorded offsets still resolve to the
same audio after tagging, and the writers were verified against real files with
`ffmpeg` and `mutagen` — decoded audio MD5 is identical before and after.

## Sources

| Source | Handles | Notes |
| --- | --- | --- |
| **YouTube** | `watch`, `youtu.be`, `shorts`, `embed`, `live`, `playlist` | `.m4a` audio; combined video tops out at 360p natively |
| **Any page** | everything else | Anchors, players, inline JSON |

Adding a source is one module in `src/core/providers/` plus one registry line.

YouTube stream resolution goes through InnerTube impersonating the iOS client,
which is served **unciphered** URLs — so Vectrax never downloads, sandboxes, and
evaluates YouTube's player JavaScript to recover a signature. The resulting URLs
are ordinary HTTP with range support, inheriting resume and retry unchanged.

### When yt-dlp is needed, Vectrax handles it

Some YouTube videos are capped to a short preview for clients that cannot
attest themselves — Vectrax fetches a few hundred KB and the server refuses the
rest. When that happens, Vectrax explains the problem and offers to fix it:

```
✖ [1/1] "Stretch Your Face" — HTTP 403 for https://rr3---sn-…/videoplayback?…
▲ yt-dlp is required to finish 1 item, and it is not installed.
  Vectrax would download the official yt-dlp binary to ~/.local/share/vectrax/tools/yt-dlp.
⟩ Install yt-dlp now?  yes  no
  verifying the published checksum
  ▰▰▰▰▰▰▰▰▰▰▰▰▰▱···········  56% installing yt-dlp
✔ yt-dlp 2026.07.04 installed
⟩ Retrying 1 item with yt-dlp
✔ "Stretch Your Face" recovered
```

Then it retries automatically and tags the result. You never have to know what
yt-dlp is.

**How it installs.** Vectrax uses whichever package manager you already have —
`pipx`, `winget`, `scoop`, or `brew` — and falls back to downloading the
official standalone binary from yt-dlp's GitHub releases into its own tools
directory. Nothing is assumed: not Python, not pip, not any particular manager.

**Safety.** It always asks first and shows exactly what it will do. Commands run
through `spawn` with an argument array — never a shell, so nothing can be
injected. Downloaded binaries are checked against the published `SHA2-256SUMS`
and discarded on mismatch. The binary is staged and renamed, so a failed install
leaves nothing behind. If anything goes wrong you get the reason and the manual
command.

`-y` deliberately does **not** cover installation — skipping a download
confirmation is not consent to install software. For unattended use, pass
`--install-fallback`. `--no-fallback` disables the whole mechanism.

Because yt-dlp multiplexes with ffmpeg, the fallback also lifts the 360p video
ceiling: `--video --quality 1080p` works through it.

### DRM-protected services are refused, not attempted

Spotify, Apple Music, Tidal, Deezer, and the video streamers encrypt their
streams. **Vectrax does not circumvent DRM.** Paste one of those links and you
get a clear explanation rather than a confusing scrape failure.

## Cross-platform

Vectrax behaves the same on Linux, macOS, and Windows.

| Concern | Handling |
| --- | --- |
| Config / data | XDG on Linux, `Application Support` on macOS, `AppData` on Windows |
| Executable lookup | `PATH` walk honouring `PATHEXT` on Windows |
| Process spawning | Argument arrays, never a shell; `windowsHide` on child processes |
| Colour | Truecolor on Windows Terminal, VS Code, ConEmu, and Windows 10 build ≥ 14931 |
| Unicode | Chemical glyphs where supported, ASCII fallback otherwise; force with `VECTRAX_ASCII` |
| Terminal width | Conhost's auto-wrap column reserved so lines never wrap |
| Filenames | Reserved device names, illegal characters, and trailing dots handled for NTFS |
| Paths | `path` throughout, `~` expansion, cross-device moves fall back to copy+unlink |

## Output and scripting

Results go to stdout, progress and diagnostics to stderr, so `vectrax scan <url>
--json | jq` works while the interface stays on screen. `--json` disables
prompts and emits structured output. Every interactive step has a flag that
replaces it; without a TTY, Vectrax names the flag instead of hanging. Colour
follows `NO_COLOR` and `FORCE_COLOR`.

| Exit | Meaning |
| --- | --- |
| `0` / `2` / `3` | Success / usage error / network |
| `4` / `5` / `6` | Filesystem / nothing found / partial failure |
| `130` | Interrupted |

## Interface

The terminal UI adapts from roughly 30 columns to fullscreen. Columns drop in
priority order as space runs out — ETA first, then rate, then byte counts, then
the bar — and text reflows rather than being cut off. Resize events repaint
immediately. Below ~44 columns it falls back to a counter and a percentage,
which still fits.

The identity is chemical: a molecular lattice under the wordmark, which
condenses out of vapour on startup; hexagonal reaction spinners; progress bars
with a reactive leading edge that cycles through residue glyphs as they fill.
Purple throughout, with white text. Set `VECTRAX_NO_ANIMATION` to skip the
startup reaction, `VECTRAX_NO_BANNER` to skip the banner entirely.

## Resumable downloads

Bytes land in `<name>.vxpart` with a sidecar recording the server's validators
(`ETag`, `Last-Modified`, size). The real filename appears only via an atomic
rename, once the transfer is complete and its length verified.

Ctrl+C is safe — re-run the same command and transfers pick up where they
stopped via range requests. Partial bytes are reused only when the validators
still match; if the remote file changed, Vectrax starts over rather than
splicing two versions together.

## Architecture

```
src/
├── bin/           entry point: terminal restore, error reporting, exit codes
├── cli/           command surface, per-command orchestration
├── config/        zod schema, layered resolution, persistence
├── core/          no terminal dependencies — usable as a library
│   ├── http/      fetch client (manual redirects, retry, scoped timeouts), URL guard
│   ├── providers/ registry + youtube, unsupported, page (catch-all)
│   ├── metadata/  id3, flac, mp4 readers/writers; embedding pipeline
│   ├── scrape/    extraction, discovery, taxonomy
│   ├── download/  engine, resume, atomic writes, filename derivation
│   ├── quality.ts intent presets, nearest-match selection
│   ├── convert/   format registry, remux-vs-transcode planning, ffmpeg runner
│   ├── fallback/  yt-dlp detection, installation, hand-off
│   └── util/      concurrency pool, formatting, filesystem and platform helpers
├── ui/            theme, chemistry, layout, banner, logger, live region, dashboard,
│                  prompts
└── index.ts       public library surface
```

Two boundaries carry the weight. **Providers only resolve** — they turn a URL
into candidates and never open a socket for the media, touch the filesystem, or
prompt; the page scraper is itself a provider, the catch-all one, so adding a
source is one module plus one registry line. **The engine only moves bytes** —
it knows nothing about containers, tags, or terminals; it publishes immutable
`TaskSnapshot`s and something else decides how to draw them. Where a provider
needs specific behaviour it passes data on the request (`headers`,
`failureHint`, `filename`) rather than the engine learning anything
source-specific.

The code carries no comments. Names and structure are the documentation; this
file holds the rationale.

### As a library

```ts
import { HttpClient, discoverWithFallback, DownloadEngine, applyMetadata } from 'vectrax';

const http = new HttpClient();
const { items } = await discoverWithFallback(http, new URL(url), {
  kinds: ['audio'],
  media: 'auto',
});

const engine = new DownloadEngine(http, { concurrency: 4 });
const outcomes = await engine.run(
  items.map((item, i) => ({
    id: String(i),
    url: item.url,
    title: item.title,
    outputDir: './downloads',
    headers: item.headers,
  })),
);

await applyMetadata(
  http,
  outcomes
    .filter((o) => o.state === 'completed')
    .map((o, i) => ({ path: o.path!, metadata: items[i]!.metadata ?? {} })),
);
```

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest
npm run build       # tsup -> dist/
```

340 tests, none touching the network. Pure units cover formatting, filename
safety, the URL guard, selection and quality parsing, the extractor, the
concurrency pool, provider URL/format/playlist parsing, responsive layout, and
tag-field validation, and yt-dlp format-selector construction. Integration tests drive the download engine and tagging
pipeline against real HTTP servers on loopback — ranges, resume, retries,
redirects, truncation, conflict policies, cancellation, per-request headers,
timeout scoping, artwork caching, and failure isolation. The fallback is
exercised against stub binaries on PATH — success, non-zero exit, missing
output, progress parsing, abort, and timeout — so the suite never shells out to
the real tool. The installer is tested against a local server: checksum
verification, checksum mismatch rejection, no leftover partial file, missing
checksum list, progress, package-manager success and failure, and a case
asserting shell metacharacters reach the child as literal arguments. Tag
round-trips run against synthetic-but-valid MP3/FLAC/MP4 containers, including
an MP4 whose `stco` offsets are asserted to still resolve after a tag resize.

## Limitations

- **YouTube video is capped at 360p natively.** Higher resolutions exist only as
  separate video-only streams; Vectrax does not multiplex and will not hand you a
  silent file. The yt-dlp fallback lifts this.
- **Some YouTube videos are preview-capped.** The server sends a few hundred KB
  and then refuses the rest — measured at exactly 768 KB on affected videos, and
  re-minting the URL does not reset it. Vectrax cannot lift this on its own;
  the yt-dlp fallback handles it, installing yt-dlp for you if you allow it.
- **No authenticated sessions**, so private, age-restricted, and subscriber-only
  content is out of reach.
- **Client-side-rendered pages** are invisible to the scraper. Vectrax detects
  this and says so; pass the media URL directly.
- **Opus/WebM audio is not taggable** by Vectrax's own writer, which is why
  `.m4a` is preferred; converting to those formats falls back to ffmpeg metadata
  and loses artwork.
- **Conversion needs ffmpeg.** Vectrax detects it and explains the
  install command; it does not install ffmpeg automatically the way it does
  yt-dlp, because ffmpeg has no single official cross-platform binary to verify.
