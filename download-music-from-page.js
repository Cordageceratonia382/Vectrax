#!/usr/bin/env node

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');
const http = require('http');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

const DEFAULT_STAGING = path.join(os.homedir(), 'Downloads', 'Master Downloader');

let spinnerIndex = 0;
let progressInterval = null;
let startTime = Date.now();

function getSpinner() { return SPINNER_FRAMES[spinnerIndex++ % SPINNER_FRAMES.length]; }

function fetchPage(urlStr, retries = 3) {
  return new Promise((resolve, reject) => {
    const fetch = (attempt) => {
      const parsed = new URL(urlStr);
      const client = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                     Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                     'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
        },
        timeout: 30000,
      };
      const req = client.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetch(new URL(res.headers.location, urlStr).href, attempt - 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', (err) => {
        if (attempt > 1) setTimeout(() => fetch(attempt - 1), 1000);
        else reject(err);
      });
        req.on('timeout', () => {
          req.destroy();
          if (attempt > 1) setTimeout(() => fetch(attempt - 1), 1000);
          else reject(new Error('Request timeout'));
        });
          req.end();
    };
    fetch(retries);
  });
}

function extractAudioLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const audioExts = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'wma', 'alac'];
  const extPattern = new RegExp(`\\.(${audioExts.join('|')})(\\?|$|\\s|["'])`, 'i');

  const allUrls = html.match(/https?:\/\/[^\s"']+/g) || [];
  for (const raw of allUrls) {
    const clean = raw.replace(/["']$/, '');
    if (extPattern.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      links.push(clean);
    }
  }

  const hrefRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];
    if (href.startsWith('//')) href = 'https:' + href;
      else if (href.startsWith('/')) href = new URL(href, baseUrl).href;
      else if (!href.startsWith('http://') && !href.startsWith('https://')) {
        href = new URL(href, baseUrl).href;
      }
      if (extPattern.test(href) && !seen.has(href)) {
        seen.add(href);
        links.push(href);
      }
  }

  const srcRegex = /<source[^>]+src=["']([^"']+)["']/gi;
  while ((match = srcRegex.exec(html)) !== null) {
    let src = match[1];
    if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/')) src = new URL(src, baseUrl).href;
      else if (!src.startsWith('http://') && !src.startsWith('https://')) {
        src = new URL(src, baseUrl).href;
      }
      if (extPattern.test(src) && !seen.has(src)) {
        seen.add(src);
        links.push(src);
      }
  }

  return links;
}

function extractSongNames(html, links) {
  const names = [];
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : 'Audio';

  for (const link of links) {
    const parsed = new URL(link);
    const filename = path.basename(parsed.pathname);
    let name = filename;
    if (filename && filename.length > 4) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      if (base.length > 3) name = base.replace(/[_-]/g, ' ').trim();
    }
    if (!name || name.length < 2) name = pageTitle;
    names.push(name.substring(0, 60));
  }
  return names;
}

function getFileSize(urlStr) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    };
    const req = client.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getFileSize(new URL(res.headers.location, urlStr).href).then(resolve);
      }
      const size = parseInt(res.headers['content-length'], 10);
      resolve(isNaN(size) ? 0 : size);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

async function downloadFile(fileUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fileUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                     Referer: 'https://www.musicdagh.ir/',
      },
      timeout: 120000,
    };
    const req = client.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(new URL(res.headers.location, fileUrl).href, destPath, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const stream = fsSync.createWriteStream(destPath);
      let downloaded = 0;
      const total = parseInt(res.headers['content-length'], 10) || 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress) onProgress(downloaded, total);
      });
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          resolve({ success: true, size: downloaded, total });
        });
        stream.on('error', (err) => {
          fsSync.unlink(destPath, () => {});
          reject(err);
        });
        res.on('error', (err) => {
          fsSync.unlink(destPath, () => {});
          reject(err);
        });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });
    req.end();
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function createProgressBar(percent, barWidth = 30) {
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = `${COLORS.green}█${COLORS.reset}`.repeat(filled) + `${COLORS.dim}░${COLORS.reset}`.repeat(empty);
  return `${bar} ${COLORS.magenta}${Math.round(percent)}%${COLORS.reset}`;
}

function createFileProgressBar(downloaded, total, barWidth = 20) {
  if (total === 0) {
    return `${COLORS.yellow}${getSpinner()}${COLORS.reset} ${formatBytes(downloaded)} / ?`;
  }
  const percent = (downloaded / total) * 100;
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = `${COLORS.green}█${COLORS.reset}`.repeat(filled) + `${COLORS.dim}░${COLORS.reset}`.repeat(empty);
  return `${bar} ${COLORS.magenta}${Math.round(percent)}%${COLORS.reset} (${formatBytes(downloaded)} / ${formatBytes(total)})`;
}

function renderStatus(filesStatus, spinner) {
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);

  const totalBytes = filesStatus.reduce((sum, f) => sum + f.total, 0);
  const downloadedBytes = filesStatus.reduce((sum, f) => sum + (f.status === 'done' ? f.total : f.downloaded), 0);

  const overallPercent = totalBytes === 0 ? 0 : (downloadedBytes / totalBytes) * 100;
  const overallBar = createProgressBar(overallPercent, 40);
  console.log(`${COLORS.cyan}${COLORS.bold}[OVERALL]${COLORS.reset} ${overallBar}  (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const doneCount = filesStatus.filter(f => f.status === 'done').length;
  console.log(`${COLORS.dim}Time: ${elapsed}s   Files: ${doneCount}/${filesStatus.length}${COLORS.reset}`);

  for (let i = 0; i < filesStatus.length; i++) {
    const f = filesStatus[i];
    let line = '';
    const name = f.name.length > 35 ? f.name.substring(0, 32) + '...' : f.name;
    if (f.status === 'done') {
      line = `  ${COLORS.green}[DOWNLOADED]${COLORS.reset} ${COLORS.white}${name}${COLORS.reset}`;
    } else if (f.status === 'downloading') {
      const progress = createFileProgressBar(f.downloaded, f.total);
      line = `  ${COLORS.yellow}${spinner}${COLORS.reset} ${COLORS.white}${name}${COLORS.reset} ${progress}`;
    } else if (f.status === 'failed') {
      line = `  ${COLORS.red}[FAILED]${COLORS.reset} ${COLORS.white}${name}${COLORS.reset}`;
    } else {
      line = `  ${COLORS.dim}[PENDING]${COLORS.reset} ${COLORS.white}${name}${COLORS.reset}`;
    }
    console.log(line);
  }
  console.log(`${COLORS.dim}Press Ctrl+C to cancel${COLORS.reset}`);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200);
}

function cleanPathInput(input) {
  let p = input.trim();
  // remove surrounding quotes (single or double)
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  return p;
}

function askSelection(total) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`\n${COLORS.yellow}${COLORS.bold}[SELECTION]${COLORS.reset}`);
    console.log(`${COLORS.dim}Enter numbers separated by space (e.g. 1 3 5) or type "all" to download everything.${COLORS.reset}`);
    rl.question(`${COLORS.cyan}> ${COLORS.reset}`, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'all') return resolve('all');
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const indices = parts.map(Number).filter(n => !isNaN(n) && n >= 1 && n <= total);
      resolve(indices.length ? indices : null);
    });
  });
}

function confirmAction(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${COLORS.red}${COLORS.bold}[CONFIRM]${COLORS.reset} ${prompt} (yes/no) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes' || answer.trim().toLowerCase() === 'y');
    });
  });
}

function askEndCommand() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`\n${COLORS.yellow}${COLORS.bold}[WAITING]${COLORS.reset} Type "${COLORS.cyan}end${COLORS.reset}" to finish and continue.`);
    rl.question(`${COLORS.cyan}> ${COLORS.reset}`, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'end');
    });
  });
}

function askPathInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`\n${COLORS.yellow}${COLORS.bold}[PATH SELECTION]${COLORS.reset}`);
    console.log(`${COLORS.dim}Enter a destination path or type "${COLORS.cyan}--path${COLORS.dim}" to browse interactively.${COLORS.reset}`);
    rl.question(`${COLORS.cyan}> ${COLORS.reset}`, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function fileExplorer(startPath = process.cwd()) {
  return new Promise((resolve) => {
    let currentPath = startPath;
    let items = [];
    let selected = 0;
    let top = 0;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const render = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      console.log(`${COLORS.bold}${COLORS.blue}+----------------------------------------------+${COLORS.reset}`);
      console.log(`${COLORS.bold}${COLORS.blue}|${COLORS.reset} ${COLORS.cyan}FILE EXPLORER${COLORS.reset}`);
      console.log(`${COLORS.bold}${COLORS.blue}|${COLORS.reset} ${COLORS.dim}${currentPath}${COLORS.reset}`);
      console.log(`${COLORS.bold}${COLORS.blue}+----------------------------------------------+${COLORS.reset}`);

      const displayItems = items.slice(top, top + 15);
      for (let i = 0; i < displayItems.length; i++) {
        const idx = top + i;
        const item = displayItems[i];
        const isDir = item.isDirectory();
        const prefix = isDir ? '[DIR]' : '[FILE]';
        const name = item.name;
        const selectedMarker = idx === selected ? `${COLORS.bgGreen}${COLORS.black} >> ${COLORS.reset}` : '    ';
        const color = isDir ? COLORS.cyan : COLORS.white;
        console.log(`${COLORS.blue}|${COLORS.reset} ${selectedMarker}${color}${prefix} ${name}${COLORS.reset}`);
      }

      const totalDisplayed = Math.min(items.length - top, 15);
      for (let i = totalDisplayed; i < 15; i++) {
        console.log(`${COLORS.blue}|${COLORS.reset}`);
      }
      console.log(`${COLORS.bold}${COLORS.blue}+----------------------------------------------+${COLORS.reset}`);
      console.log(`${COLORS.blue}|${COLORS.reset} ${COLORS.dim}UP/DOWN navigate  ENTER select  LEFT/back  Q quit${COLORS.reset}`);
      console.log(`${COLORS.bold}${COLORS.blue}+----------------------------------------------+${COLORS.reset}`);
    };

    const loadDir = async (dir) => {
      try {
        const files = await fs.readdir(dir, { withFileTypes: true });
        items = files.filter(f => f.isDirectory() || f.isFile());
        items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        selected = 0;
        top = 0;
        render();
      } catch (err) {
        console.log(`${COLORS.red}Error reading directory${COLORS.reset}`);
        setTimeout(render, 300);
      }
    };

    const handleKey = async (str, key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        process.stdin.setRawMode(false);
        process.stdin.removeAllListeners('keypress');
        rl.close();
        resolve(null);
        return;
      }

      if (key.name === 'up') {
        if (selected > 0) {
          selected--;
          if (selected < top) top = selected;
          render();
        }
        return;
      }

      if (key.name === 'down') {
        if (selected < items.length - 1) {
          selected++;
          if (selected >= top + 15) top = selected - 14;
          render();
        }
        return;
      }

      if (key.name === 'left' || key.name === 'backspace') {
        const parent = path.dirname(currentPath);
        if (parent !== currentPath) {
          currentPath = parent;
          await loadDir(currentPath);
        }
        return;
      }

      if (key.name === 'return') {
        const item = items[selected];
        if (!item) return;
        const fullPath = path.join(currentPath, item.name);
        if (item.isDirectory()) {
          currentPath = fullPath;
          await loadDir(currentPath);
        } else {
          process.stdin.setRawMode(false);
          process.stdin.removeAllListeners('keypress');
          rl.close();
          resolve(fullPath);
        }
      }
    };

    process.stdin.on('keypress', handleKey);

    loadDir(currentPath).catch(() => {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('keypress');
      rl.close();
      resolve(null);
    });
  });
}

async function moveFiles(files, destDir) {
  let success = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const destPath = path.join(destDir, path.basename(file));
      await fs.rename(file, destPath);
      success++;
    } catch {
      try {
        await fs.copyFile(file, path.join(destDir, path.basename(file)));
        await fs.unlink(file);
        success++;
      } catch {
        failed++;
      }
    }
  }
  return { success, failed };
}

async function main() {
  const args = process.argv.slice(2);
  let pageUrl = null;
  let outputDir = DEFAULT_STAGING;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--link=')) pageUrl = args[i].split('=')[1];
    else if (args[i] === '--link' && i + 1 < args.length) pageUrl = args[++i];
    else if (args[i].startsWith('--output=')) outputDir = args[i].split('=')[1];
    else if (args[i] === '--output' && i + 1 < args.length) outputDir = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`\n${COLORS.bold}Usage:${COLORS.reset} node music-dl.js --link="<url>" [--output=<dir>]`);
      console.log(`\n${COLORS.dim}Example:${COLORS.reset}`);
      console.log(`  node music-dl.js --link="https://www.musicdagh.ir/..."`);
      console.log(`  node music-dl.js --link="..." --output="./my-songs"`);
      console.log(`\n${COLORS.dim}Default staging directory: ${DEFAULT_STAGING}${COLORS.reset}`);
      console.log();
      process.exit(0);
    }
  }

  if (!pageUrl) {
    console.error(`${COLORS.red}[ERROR]${COLORS.reset} No link provided. Use --link="<url>"`);
    process.exit(1);
  }

  process.on('SIGINT', () => {
    if (progressInterval) clearInterval(progressInterval);
    console.log(`\n${COLORS.yellow}[CANCEL]${COLORS.reset} Interrupted.`);
    process.exit(0);
  });

  try {
    console.log(`\n${COLORS.blue}${COLORS.bold}+----------------------------------------------+${COLORS.reset}`);
    console.log(`${COLORS.blue}${COLORS.bold}|${COLORS.reset}  [ MUSIC DOWNLOADER ]                        ${COLORS.blue}${COLORS.bold}|${COLORS.reset}`);
    console.log(`${COLORS.blue}${COLORS.bold}+----------------------------------------------+${COLORS.reset}\n`);

    console.log(`${COLORS.blue}${COLORS.bold}[MUSIC-DL]${COLORS.reset} Page: ${COLORS.cyan}${pageUrl}${COLORS.reset}`);
    console.log(`${COLORS.blue}${COLORS.bold}[MUSIC-DL]${COLORS.reset} Staging: ${COLORS.cyan}${outputDir}${COLORS.reset}\n`);

    await fs.mkdir(outputDir, { recursive: true });

    console.log(`${COLORS.yellow}[SCANNING]${COLORS.reset} Fetching page...`);
    const html = await fetchPage(pageUrl);
    console.log(`${COLORS.green}[OK]${COLORS.reset} Page loaded (${(html.length / 1024).toFixed(1)} KB)`);

    const links = extractAudioLinks(html, pageUrl);
    if (links.length === 0) {
      console.log(`${COLORS.red}[ERROR]${COLORS.reset} No audio files found on this page.`);
      console.log(`${COLORS.dim}The page may use JavaScript or external players.${COLORS.reset}`);
      return;
    }

    const uniqueLinks = [...new Set(links)];
    const songNames = extractSongNames(html, uniqueLinks);
    const total = uniqueLinks.length;

    console.log(`\n${COLORS.yellow}[FOUND]${COLORS.reset} ${total} audio file(s):\n`);
    for (let i = 0; i < total; i++) {
      const name = songNames[i] || `file_${i+1}`;
      console.log(`  ${COLORS.bold}${i+1}${COLORS.reset}. ${COLORS.cyan}${name}${COLORS.reset}`);
    }
    console.log();

    const selection = await askSelection(total);
    if (!selection) {
      console.log(`${COLORS.yellow}[CANCEL]${COLORS.reset} No valid selection.`);
      return;
    }

    let selectedIndices;
    if (selection === 'all') selectedIndices = uniqueLinks.map((_, i) => i);
    else selectedIndices = selection.map(n => n - 1);

    const selectedLinks = selectedIndices.map(i => uniqueLinks[i]);
    const selectedNames = selectedIndices.map(i => songNames[i] || `file_${i+1}`);

    console.log(`\n${COLORS.yellow}[SELECTED]${COLORS.reset} ${selectedLinks.length} file(s):`);
    for (let i = 0; i < selectedLinks.length; i++) {
      console.log(`  ${i+1}. ${COLORS.cyan}${selectedNames[i]}${COLORS.reset}`);
    }
    console.log();

    const ok = await confirmAction(`Download ${selectedLinks.length} file(s) to staging "${outputDir}"?`);
    if (!ok) {
      console.log(`${COLORS.green}[CANCEL]${COLORS.reset} Operation cancelled.`);
      return;
    }

    console.log(`\n${COLORS.yellow}[PREPARING]${COLORS.reset} Fetching file sizes...`);
    const filesStatus = [];
    let totalBytes = 0;
    for (let i = 0; i < selectedLinks.length; i++) {
      const size = await getFileSize(selectedLinks[i]);
      filesStatus.push({
        name: selectedNames[i],
        link: selectedLinks[i],
        downloaded: 0,
        total: size,
        status: 'pending',
      });
      totalBytes += size;
    }
    console.log(`${COLORS.green}[OK]${COLORS.reset} Sizes fetched. Total size: ${formatBytes(totalBytes)}`);

    const downloadedFiles = [];
    let failedCount = 0;

    startTime = Date.now();

    console.log('\n'.repeat(6));
    progressInterval = setInterval(() => {
      const spinner = getSpinner();
      renderStatus(filesStatus, spinner);
    }, 80);

    for (let i = 0; i < filesStatus.length; i++) {
      const f = filesStatus[i];
      f.status = 'downloading';
      const urlPath = new URL(f.link).pathname;
      let ext = path.extname(urlPath);
      const validExts = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.wma', '.alac'];
      if (!validExts.includes(ext.toLowerCase())) ext = '.mp3';
      const safeName = sanitizeFilename(f.name);
      let destPath = path.join(outputDir, `${safeName}${ext}`);
      let counter = 1;
      while (true) {
        try { await fs.access(destPath); destPath = path.join(outputDir, `${safeName}_${counter}${ext}`); counter++; }
        catch { break; }
      }

      try {
        const result = await downloadFile(f.link, destPath, (downloaded, total) => {
          f.downloaded = downloaded;
          f.total = total;
        });
        if (result.success) {
          f.status = 'done';
          f.downloaded = result.size;
          f.total = result.total || f.total;
          downloadedFiles.push(destPath);
        } else {
          f.status = 'failed';
          failedCount++;
        }
      } catch (err) {
        f.status = 'failed';
        failedCount++;
      }
    }

    clearInterval(progressInterval);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    renderStatus(filesStatus, '');
    console.log('\n');

    console.log(`${COLORS.green}${COLORS.bold}+----------------------------------------------+${COLORS.reset}`);
    console.log(`${COLORS.green}${COLORS.bold}|${COLORS.reset}  [ DOWNLOAD COMPLETE ]                        ${COLORS.green}${COLORS.bold}|${COLORS.reset}`);
    console.log(`${COLORS.green}${COLORS.bold}+----------------------------------------------+${COLORS.reset}`);
    const successCount = filesStatus.filter(f => f.status === 'done').length;
    console.log(`  ${COLORS.green}[OK]${COLORS.reset} Downloaded: ${COLORS.bold}${successCount}${COLORS.reset}`);
    if (failedCount > 0) {
      console.log(`  ${COLORS.red}[FAIL]${COLORS.reset} Failed: ${COLORS.bold}${failedCount}${COLORS.reset}`);
      filesStatus.filter(f => f.status === 'failed').forEach(f => console.log(`    ${f.name}`));
    }
    console.log(`  ${COLORS.dim}Staging location: ${outputDir}${COLORS.reset}\n`);

    if (downloadedFiles.length === 0) {
      console.log(`${COLORS.yellow}[INFO]${COLORS.reset} No files were successfully downloaded.`);
      return;
    }

    const end = await askEndCommand();
    if (!end) {
      console.log(`${COLORS.yellow}[INFO]${COLORS.reset} Skipping move operation. Files remain in staging: ${COLORS.cyan}${outputDir}${COLORS.reset}`);
      return;
    }

    const movePrompt = await confirmAction('Do you want to move these files to another location?');
    if (!movePrompt) {
      console.log(`${COLORS.green}[DONE]${COLORS.reset} All files saved in staging: ${COLORS.cyan}${outputDir}${COLORS.reset}`);
      return;
    }

    let targetPath = null;
    while (true) {
      const input = await askPathInput();
      const cleaned = cleanPathInput(input);
      if (cleaned.toLowerCase() === '--path') {
        const chosen = await fileExplorer(process.cwd());
        if (chosen) {
          targetPath = chosen;
          break;
        } else {
          console.log(`${COLORS.yellow}[INFO]${COLORS.reset} Browse cancelled. Try again or type a path.`);
        }
      } else if (cleaned && cleaned.length > 0) {
        const resolved = path.resolve(cleaned);
        try {
          await fs.mkdir(resolved, { recursive: true });
          targetPath = resolved;
          break;
        } catch {
          console.log(`${COLORS.red}[ERROR]${COLORS.reset} Invalid path. Try again.`);
        }
      } else {
        console.log(`${COLORS.yellow}[INFO]${COLORS.reset} Please enter a valid path or --path to browse.`);
      }
    }

    if (!targetPath) {
      console.log(`${COLORS.yellow}[INFO]${COLORS.reset} No destination selected. Files remain in staging: ${COLORS.cyan}${outputDir}${COLORS.reset}`);
      return;
    }

    console.log(`\n${COLORS.yellow}[MOVING]${COLORS.reset} Moving ${downloadedFiles.length} file(s) to ${COLORS.cyan}${targetPath}${COLORS.reset}...`);

    const moveResult = await moveFiles(downloadedFiles, targetPath);

    console.log(`\n${COLORS.green}[MOVE]${COLORS.reset} ${moveResult.success} file(s) moved successfully.`);
    if (moveResult.failed > 0) {
      console.log(`${COLORS.red}[FAIL]${COLORS.reset} ${moveResult.failed} file(s) could not be moved.`);
    }
    console.log(`${COLORS.green}[DONE]${COLORS.reset} Operation completed.`);

  } catch (err) {
    if (progressInterval) clearInterval(progressInterval);
    console.error(`${COLORS.red}[FATAL]${COLORS.reset} ${err.message}`);
    process.exit(1);
  }
}

main();
