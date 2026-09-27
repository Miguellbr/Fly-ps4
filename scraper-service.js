/**
 * PS4 Scraper Service (Fly.io)
 * Single source of truth for: page load, structural extraction, classification, URL validation/resolution.
 *
 * API:
 *   GET  /         status
 *   GET  /health   health + uptime
 *   POST /scrape   { url, titleId?, gameName? }  header x-api-key
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromiumPromise = import('@sparticuz/chromium');

const stealth = StealthPlugin();
puppeteerExtra.use(stealth);


// CUSTOM STEALTH CONFIGURATION
// Espaço reservado para configurações adicionais.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API_KEY = process.env.API_KEY || 'dev-key';
const PORT = Number(process.env.PORT) || 8080;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const CACHE_LOGIC_VERSION = 'v4'; // v4: embedded is candidate only; browser must confirm
const PAGE_GOTO_TIMEOUT_MS = 30000;
const RESOLVE_GOTO_TIMEOUT_MS = 15000;
const POST_LOAD_WAIT_MS = 2000;
const POST_RESOLVE_WAIT_MS = 1500;
const MAX_CANDIDATES = 60;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESOLVE_HOPS = 5;

// Central host lists (used by extraction AND resolution — never diverge)
const DOWNLOAD_HOST_HINTS = Object.freeze([
  'mediafire',
  '1fichier',
  'mega.nz',
  'mega.co.nz',
  'mega',
  'gofile',
  'pixeldrain',
  'qiwi',
  'katfile',
  'mixdrop',
  'dropbox',
  'drive.google',
  'googleusercontent',
  'akirabox',
  'vikingfile',
  'workupload'
]);

const INTERMEDIATE_HOSTS = Object.freeze([
  'shrinkearn.com',
  'shrinkme.io',
  'linkvertise.com',
  'ouo.io',
  'adf.ly',
  'bit.ly',
  'cutt.ly',
  'clk.sh',
  'clks.pro',
  'short.ink'
]);

// Central regexes
const DLC_RE = /\b(dlc|downloadable\s*content|season\s*pass|expansion|add[- ]?on|bonus\s*pack|costume\s*pack|character\s*pack)\b/i;
const UPDATE_RE = /\b(update|patch|ver(?:sion)?\.?\s*\d|v\d+\.\d+)\b/i;
const NAV_TEXT_RE = /\b(guide\s*download|tool\s*download|guide\s*download\s*game|daily\s*update|update\s*list\s*all\s*game|list\s*all\s*game|all\s*game\s*(ps[2345]|vita|psp)|ps[2345]\s*list|home|about|contact|privacy|terms|login|register|search|category|tag|archive|sitemap)\b/i;
const DOWNLOAD_SIGNAL_RE = /\b(download|mirror|part\s*\d+|pkg|base|game|disc|iso|link|host)\b/i;
const HOST_LABEL_RE = /^(mediafire|1fichier|1file|mega|gofile|pixeldrain|akia|akira|akirabox|viki|viking|vikingfile|dropbox|drive|google\s*drive|qiwi|katfile|mixdrop|workupload|mirror\s*\d*|part\s*\d+|link\s*\d+)$/i;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: MAX_BODY_BYTES }));

const cache = new Map();

function newReqId() {
  return crypto.randomBytes(4).toString('hex');
}

function log(reqId, stage, ...args) {
  console.log(`[REQ ${reqId}] [${stage}]`, ...args);
}

// ---------------------------------------------------------------------------
// URL helpers + central validation
// ---------------------------------------------------------------------------
function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isKnownFinalHost(hostname) {
  if (!hostname) return false;
  return DOWNLOAD_HOST_HINTS.some((h) => hostname.includes(h));
}

function isIntermediateHost(hostname) {
  if (!hostname) return false;
  return INTERMEDIATE_HOSTS.some((h) => hostname.includes(h));
}

function samePageUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const ha = ua.hostname.replace(/^www\./, '');
    const hb = ub.hostname.replace(/^www\./, '');
    const pa = ua.pathname.replace(/\/$/, '') || '/';
    const pb = ub.pathname.replace(/\/$/, '') || '/';
    return ha === hb && pa === pb;
  } catch {
    return false;
  }
}

/**
 * Central validation for a candidate resolved URL.
 * success/valid means: HTTP(S), not empty, not same as source page,
 * not an intermediate host, and is a known final download host.
 */
function validateResolvedUrl(candidateUrl, originalUrl, sourcePageUrl) {
  if (!candidateUrl || typeof candidateUrl !== 'string') {
    return { valid: false, url: null, host: '', reason: 'URL vazia ou inválida' };
  }

  if (!isHttpUrl(candidateUrl)) {
    return { valid: false, url: null, host: '', reason: 'Protocolo não HTTP(S)' };
  }

  const host = hostOf(candidateUrl);
  if (!host) {
    return { valid: false, url: null, host: '', reason: 'Host ausente' };
  }

  if (sourcePageUrl && samePageUrl(candidateUrl, sourcePageUrl)) {
    return { valid: false, url: null, host, reason: 'Mesma URL da página de origem' };
  }

  if (originalUrl && samePageUrl(candidateUrl, originalUrl) && !isKnownFinalHost(host)) {
    return { valid: false, url: null, host, reason: 'Igual à URL original sem ser host final' };
  }

  if (isIntermediateHost(host)) {
    return { valid: false, url: null, host, reason: 'Host intermediário' };
  }

  if (!isKnownFinalHost(host)) {
    return { valid: false, url: null, host, reason: 'Host não é destino final conhecido' };
  }

  return { valid: true, url: candidateUrl, host, reason: 'ok' };
}

/**
 * Extract embedded destination from shortener query (e.g. shrinkearn ?url=base64).
 * Does NOT mark success — only returns a candidate string or null.
 */
function tryDecodeEmbeddedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    if (host.includes('shrinkearn') || host.includes('shrinkme')) {
      const encoded = u.searchParams.get('url');
      if (encoded) {
        let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }

    for (const key of ['url', 'destination', 'dest', 'target', 'r', 'redirect']) {
      const val = u.searchParams.get(key);
      if (val && /^https?:\/\//i.test(val)) return val;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Navigate once with Puppeteer and report the browser-confirmed URL + redirect chain.
 * Does not validate — caller decides success.
 */
async function navigateOnce(page, targetUrl, reqId) {
  log(reqId, 'RESOLVE', `navigation → ${String(targetUrl).slice(0, 120)}`);
  try {
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: RESOLVE_GOTO_TIMEOUT_MS
    });
    // Allow soft redirects / History API updates after load
    await new Promise((r) => setTimeout(r, POST_RESOLVE_WAIT_MS));

    const currentUrl = page.url() || targetUrl;
    const status = response?.status?.() ?? null;

    let redirectChain = [];
    try {
      const req = response?.request?.();
      const chain = req?.redirectChain?.() || [];
      redirectChain = chain.map((r) => r.url()).filter(Boolean);
      if (currentUrl && !redirectChain.includes(currentUrl)) {
        redirectChain = [...redirectChain, currentUrl];
      }
    } catch {
      redirectChain = [currentUrl];
    }

    log(reqId, 'RESOLVE', `current URL: ${String(currentUrl).slice(0, 120)}`);
    if (redirectChain.length) {
      log(
        reqId,
        'RESOLVE',
        `redirect chain: ${redirectChain.map((u) => hostOf(u) || u.slice(0, 40)).join(' → ')}`
      );
    }

    return { ok: true, url: currentUrl, host: hostOf(currentUrl), status, redirectChain, error: null };
  } catch (err) {
    log(reqId, 'RESOLVE', `navigation error: ${err.message}`);
    return {
      ok: false,
      url: null,
      host: null,
      status: null,
      redirectChain: [],
      error: err.message || 'Falha ao navegar'
    };
  }
}

/**
 * Resolve intermediate → browser-confirmed final URL.
 *
 * originalUrl  = href from HTML
 * candidateUrl = URL found inside intermediate (e.g. base64 param) — NOT final by itself
 * resolvedUrl  = page.url() after navigation — only this may become success:true after validation
 *
 * Chain: A → B → C → DEST (max MAX_RESOLVE_HOPS), with loop protection.
 * Never sets success=true from parse alone.
 */
async function resolveLink(page, originalHref, sourcePageUrl, reqId) {
  // Allow navigation to complete without Puppeteer's default navigation timeout.
  page.setDefaultNavigationTimeout(0);

// Comportamento humano antes de clicar
await page.mouse.move(
Math.random() * 800 + 100,
Math.random() * 600 + 100,
{ steps: 10 }
);
await page.waitForTimeout(Math.random() * 1000 + 500);

  log(reqId, 'RESOLVE', `original URL: ${String(originalHref).slice(0, 120)}`);

  const originalHost = hostOf(originalHref);

  // Direct final host already in the HTML — no intermediate to bypass
  if (isKnownFinalHost(originalHost)) {
    const v = validateResolvedUrl(originalHref, originalHref, sourcePageUrl);
    log(reqId, 'RESOLVE', `final validation (direct): ${v.reason}`);
    if (v.valid) {
      log(reqId, 'RESOLVE', `accepted (direct) ${v.host}`);
      return { success: true, url: v.url, host: v.host, method: 'direct' };
    }
    log(reqId, 'RESOLVE', `rejected: ${v.reason}`);
    return { success: false, url: null, host: v.host, error: v.reason, method: 'direct' };
  }

  // Candidate from query/base64 — input to the resolver, never auto-success
  const embeddedCandidate = tryDecodeEmbeddedUrl(originalHref);
  if (embeddedCandidate) {
    log(
      reqId,
      'RESOLVE',
      `embedded candidate: ${hostOf(embeddedCandidate)} ${embeddedCandidate.slice(0, 100)}`
    );
  }

  // Build hop queue: start at original intermediate; then candidate if any
  const queue = [];
  const visited = new Set();
  const enqueue = (u) => {
    if (!u || !isHttpUrl(u)) return;
    const key = u.split('#')[0];
    if (visited.has(key) || queue.some((q) => q.split('#')[0] === key)) return;
    queue.push(u);
  };

  enqueue(originalHref);
  if (embeddedCandidate) enqueue(embeddedCandidate);

  let lastError = 'Não foi possível resolver o destino';
  let lastHost = originalHost;
  let hops = 0;

  while (queue.length > 0 && hops < MAX_RESOLVE_HOPS) {
    const nextUrl = queue.shift();
    const key = nextUrl.split('#')[0];
    if (visited.has(key)) continue;
    visited.add(key);
    hops++;

    log(reqId, 'RESOLVE', `attempting hop ${hops}/${MAX_RESOLVE_HOPS}: ${hostOf(nextUrl)}`);

    // If this hop target is already a known final host, still confirm via browser
    const nav = await navigateOnce(page, nextUrl, reqId);
    if (!nav.ok) {
      lastError = nav.error || 'Falha de navegação';
      continue;
    }

    lastHost = nav.host;

    log(reqId, 'RESOLVE', `final validation: ${nav.url.slice(0, 120)}`);
    const v = validateResolvedUrl(nav.url, originalHref, sourcePageUrl);
    if (v.valid) {
      log(reqId, 'RESOLVE', `accepted (navigate) ${v.host} hops=${hops}`);
      return {
        success: true,
        url: v.url,
        host: v.host,
        method: hops === 1 && !embeddedCandidate ? 'navigate' : 'navigate-chain',
        status: nav.status,
        hops
      };
    }

    log(reqId, 'RESOLVE', `rejected: ${v.reason}`);
    lastError = v.reason;

    // Continue chain: embedded on the *confirmed* URL, then on the hop we requested
    const fromConfirmed = tryDecodeEmbeddedUrl(nav.url);
    if (fromConfirmed) {
      log(reqId, 'RESOLVE', `embedded candidate (from current): ${hostOf(fromConfirmed)}`);
      enqueue(fromConfirmed);
    }
    const fromHop = tryDecodeEmbeddedUrl(nextUrl);
    if (fromHop && fromHop !== fromConfirmed) {
      enqueue(fromHop);
    }

    // If browser landed on another intermediate, follow that URL next
    if (isIntermediateHost(nav.host) && nav.url) {
      enqueue(nav.url);
    }
  }

  if (hops >= MAX_RESOLVE_HOPS) {
    lastError = `Limite de ${MAX_RESOLVE_HOPS} hops atingido`;
  }

  log(reqId, 'RESOLVE', `rejected: ${lastError}`);
  return {
    success: false,
    url: null,
    host: lastHost,
    error: lastError,
    method: 'navigate-chain',
    hops
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
function classifyLink(link) {
  const text = (link.text || '').toLowerCase();
  const href = (link.href || '').toLowerCase();
  const immediate = (link.immediateText || '').toLowerCase();

  if (NAV_TEXT_RE.test(text)) return null;

  if (DLC_RE.test(text) || DLC_RE.test(href)) return 'dlcs';

  if (UPDATE_RE.test(text) || UPDATE_RE.test(href)) {
    if (!/list\s*all|daily\s*update|guide|tool/i.test(text)) return 'updates';
  }

  if (immediate.length > 0 && immediate.length < 120) {
    if (DLC_RE.test(immediate) && !/list\s*all|guide|tool/i.test(immediate)) return 'dlcs';
    if (UPDATE_RE.test(immediate) && !/list\s*all|daily\s*update|guide|tool/i.test(immediate)) {
      return 'updates';
    }
  }

  return 'base';
}

function classifyLinks(links) {
  const classified = { base: [], updates: [], dlcs: [] };

  for (const link of links) {
    const type = classifyLink(link);
    if (!type) continue;

    const finalHost =
      link.resolved && link.resolved.success && link.resolved.host
        ? link.resolved.host
        : link.host;

    const entry = {
      href: link.href,
      text: link.text,
      host: finalHost,
      originalUrl: link.href,
      resolved: link.resolved
        ? {
            success: !!link.resolved.success,
            url: link.resolved.success ? link.resolved.url : null,
            error: link.resolved.success
              ? undefined
              : link.resolved.error || 'Não resolvido',
            method: link.resolved.method || undefined
          }
        : {
            success: false,
            url: null,
            error: 'Resolução não executada'
          }
    };

    classified[type].push(entry);
  }

  return classified;
}

// ---------------------------------------------------------------------------
// Extraction (runs inside page.evaluate — lists inlined intentionally)
// ---------------------------------------------------------------------------
async function extractLinks(page) {
  return page.evaluate(
    ({ downloadHints, intermediateHosts, maxCandidates }) => {
      const diag = {
        totalAnchors: 0,
        discardedNav: 0,
        discardedNavText: 0,
        discardedWeakSignal: 0,
        discardedLowScore: 0,
        passed: 0
      };

      const results = [];
      const seen = new Set();

      const HOST_LABEL_RE =
        /^(mediafire|1fichier|1file|mega|gofile|pixeldrain|akia|akira|akirabox|viki|viking|vikingfile|dropbox|drive|google\s*drive|qiwi|katfile|mixdrop|workupload|mirror\s*\d*|part\s*\d+|link\s*\d+)$/i;
      const NAV_TEXT_RE =
        /\b(guide\s*download|tool\s*download|guide\s*download\s*game|daily\s*update|update\s*list\s*all\s*game|list\s*all\s*game|all\s*game\s*(ps[2345]|vita|psp)|ps[2345]\s*list|home|about|contact|privacy|terms|login|register|search|category|tag|archive|sitemap)\b/i;
      const DOWNLOAD_SIGNAL_RE =
        /\b(download|mirror|part\s*\d+|pkg|base|game|disc|iso|link|host)\b/i;
      const DLC_SIGNAL_RE =
        /\b(dlc|downloadable\s*content|season\s*pass|expansion|add[- ]?on|bonus\s*pack|costume\s*pack|character\s*pack)\b/i;
      const UPDATE_SIGNAL_RE =
        /\b(update|patch|ver(?:sion)?\.?\s*\d|v\d+\.\d+)\b/i;

      const anchors = Array.from(document.querySelectorAll('a[href]'));
      diag.totalAnchors = anchors.length;

      for (const a of anchors) {
        const href = a.href;
        if (!href || !href.startsWith('http') || seen.has(href)) continue;

        const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();

        const inNav = !!a.closest(
          'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]'
        );
        const inMenuLike = !!a.closest(
          '[class*="menu"], [class*="nav"], [class*="sidebar"], [class*="footer"], [class*="header"], [class*="breadcrumb"], [id*="menu"], [id*="nav"], [id*="sidebar"], [id*="footer"], [id*="header"]'
        );
        const inContent = !!a.closest(
          'article, main, .entry-content, .post-content, .post-body, .content, .download, .links, .game-links, .download-links, .entry, .post'
        );

        if (inNav || inMenuLike) {
          diag.discardedNav++;
          continue;
        }
        if (NAV_TEXT_RE.test(text)) {
          diag.discardedNavText++;
          continue;
        }

        const immediate = a.closest('li, td, th, p, span, div');
        let immediateText = '';
        if (immediate) {
          const raw = (immediate.innerText || immediate.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          immediateText = raw.length > 160 ? raw.slice(0, 160) : raw;
        }

        let host = '';
        try {
          host = new URL(href).hostname.toLowerCase();
        } catch {
          continue;
        }

        const isKnownFinal = downloadHints.some((h) => host.includes(h));
        const isIntermediate = intermediateHosts.some((h) => host.includes(h));
        const hasFileExt = /\.(pkg|zip|rar|7z)(?:$|[?#])/i.test(href);
        const isHostLabel = HOST_LABEL_RE.test(text);
        const hasDownloadText = DOWNLOAD_SIGNAL_RE.test(text);
        const hasDlcOrUpdate = DLC_SIGNAL_RE.test(text) || UPDATE_SIGNAL_RE.test(text);
        const textMentionsHost =
          downloadHints.some((h) => text.toLowerCase().includes(h)) ||
          /akia|akira|viki|viking|1file/i.test(text);

        const strongSignal =
          isKnownFinal ||
          hasFileExt ||
          isHostLabel ||
          textMentionsHost ||
          (isIntermediate &&
            (isHostLabel || textMentionsHost || hasDownloadText || hasDlcOrUpdate || inContent)) ||
          hasDownloadText ||
          hasDlcOrUpdate;

        if (!strongSignal) {
          diag.discardedWeakSignal++;
          continue;
        }

        let score = 0;
        if (isKnownFinal) score += 10;
        if (hasFileExt) score += 8;
        if (isHostLabel || textMentionsHost) score += 8;
        if (isIntermediate && inContent) score += 6;
        if (hasDownloadText) score += 4;
        if (hasDlcOrUpdate) score += 3;
        if (inContent) score += 4;
        if (
          immediateText &&
          (DOWNLOAD_SIGNAL_RE.test(immediateText) ||
            /mediafire|1fichier|akira|viking|mega/i.test(immediateText))
        ) {
          score += 2;
        }

        try {
          if (new URL(href).origin === location.origin && !hasFileExt && !isKnownFinal) {
            score -= 5;
          }
        } catch {
          // ignore
        }

        if (score < 3) {
          diag.discardedLowScore++;
          continue;
        }

        seen.add(href);
        diag.passed++;
        results.push({
          href,
          text: text.substring(0, 100),
          host,
          score,
          inContent,
          immediateText: immediateText.substring(0, 120)
        });
      }

      results.sort((a, b) => b.score - a.score);
      return { links: results.slice(0, maxCandidates), diag };
    },
    {
      downloadHints: DOWNLOAD_HOST_HINTS,
      intermediateHosts: INTERMEDIATE_HOSTS,
      maxCandidates: MAX_CANDIDATES
    }
  );
}

// ---------------------------------------------------------------------------
// Scrape pipeline
// ---------------------------------------------------------------------------
async function scrapeWithPuppeteer(url, titleId, gameName, reqId) {
  const chromium = (await chromiumPromise).default;

  const browser = await puppeteerExtra.launch({
  args: [
    ...chromium.args,

    // 👇 AQUI entraria um argumento adicional do Chromium
    
    

'--proxy-server=http://user:pass@residential-proxy:port',
    
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ],

  executablePath: await chromium.executablePath(),
  headless: chromium.headless
});
  });

  try {
    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['pt-BR', 'pt', 'en-US', 'en']
      });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    );

    log(reqId, 'SCRAPE', `goto ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: PAGE_GOTO_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, POST_LOAD_WAIT_MS));

    const pageTitle = await page.title().catch(() => 'Unknown');
    const finalUrl = page.url();

    log(reqId, 'EXTRACT', 'start');
    const extractResult = await extractLinks(page);
    const links = extractResult.links || [];
    const diag = extractResult.diag || {};
    log(reqId, 'EXTRACT', `diag ${JSON.stringify(diag)}`);
    log(reqId, 'EXTRACT', `sample ${JSON.stringify(links.slice(0, 6).map((l) => l.text))}`);

    const resolutionCache = new Map();
    let resolvedOk = 0;
    let resolvedFail = 0;

    log(reqId, 'RESOLVE', `start count=${links.length}`);
    for (const link of links) {
      if (resolutionCache.has(link.href)) {
        link.resolved = resolutionCache.get(link.href);
        continue;
      }
      const resolution = await resolveLink(page, link.href, finalUrl, reqId);
      resolutionCache.set(link.href, resolution);
      link.resolved = resolution;
      if (resolution.success) resolvedOk++;
      else resolvedFail++;
    }
    log(reqId, 'RESOLVE', `ok=${resolvedOk} fail=${resolvedFail} unique=${resolutionCache.size}`);

    log(reqId, 'CLASSIFY', 'start');
    const classified = classifyLinks(links);
    const totalFound =
      classified.base.length + classified.updates.length + classified.dlcs.length;
    log(
      reqId,
      'CLASSIFY',
      `base=${classified.base.length} updates=${classified.updates.length} dlcs=${classified.dlcs.length}`
    );

    return {
      success: true,
      titleId: titleId || null,
      game: {
        title: pageTitle,
        sourceUrl: finalUrl
      },
      links: classified,
      stats: {
        found: totalFound,
        base: classified.base.length,
        updates: classified.updates.length,
        dlcs: classified.dlcs.length,
        resolved: resolvedOk,
        failed: resolvedFail
      },
      timestamp: new Date().toISOString()
    };
  } finally {
    try {
      await browser.close();
    } catch (e) {
      log(reqId, 'SCRAPE', `browser close warn: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PS4 Scraper',
    version: CACHE_LOGIC_VERSION,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    cacheSize: cache.size,
    version: CACHE_LOGIC_VERSION
  });
});

app.post('/scrape', async (req, res) => {
  const reqId = newReqId();
  log(reqId, 'START', 'POST /scrape');

  const authHeader = req.headers['x-api-key'];
  if (authHeader !== API_KEY) {
    log(reqId, 'AUTH', 'unauthorized');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const body = req.body || {};
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const titleId = typeof body.titleId === 'string' ? body.titleId.trim() : '';
  const gameName = typeof body.gameName === 'string' ? body.gameName.trim() : '';

  if (!url) {
    log(reqId, 'VALIDATE', 'missing url');
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    log(reqId, 'VALIDATE', 'invalid url');
    return res.status(400).json({ success: false, error: 'Invalid URL' });
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    log(reqId, 'VALIDATE', 'bad protocol');
    return res.status(400).json({ success: false, error: 'URL must be HTTP or HTTPS' });
  }

  const cacheKey = `${CACHE_LOGIC_VERSION}|${url}|${titleId}|${gameName}`;
  const cached = cache.get(cacheKey);

  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      log(reqId, 'CACHE', `HIT ageMs=${age}`);
      return res.json({ ...cached.data, cached: true });
    }
    log(reqId, 'CACHE', 'EXPIRED');
    cache.delete(cacheKey);
  } else {
    log(reqId, 'CACHE', 'MISS');
  }

  try {
    const result = await scrapeWithPuppeteer(url, titleId, gameName, reqId);
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    log(reqId, 'RESPONSE', JSON.stringify(result.stats));
    return res.json({ ...result, cached: false });
  } catch (error) {
    log(reqId, 'ERROR', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Scrape failed',
      url,
      timestamp: new Date().toISOString()
    });
  }
});

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) cache.delete(key);
  }
}, CACHE_TTL_MS);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] PS4 Scraper ${CACHE_LOGIC_VERSION} on 0.0.0.0:${PORT}`);
  console.log(`[BOOT] API key prefix: ${String(API_KEY).substring(0, 4)}...`);
});
