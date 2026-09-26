const express = require('express');
const cors = require('cors');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromiumPromise = import('@sparticuz/chromium');

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || 'dev-key';
const PORT = process.env.PORT || 8080;

// Cache em memória
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hora

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PS4 Scraper',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// Endpoint principal
app.post('/scrape', async (req, res) => {
  // Auth
  const authHeader = req.headers['x-api-key'];
  if (authHeader !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { url, titleId, gameName, attemptCaptcha } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Cache key
  const cacheKey = `${url}|${titleId || ''}|${gameName || ''}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[CACHE] Hit for', url);
    return res.json({ ...cached.data, cached: true });
  }

  console.log('[SCRAPE] Starting:', url);

  try {
    const result = await scrapeWithPuppeteer(url, titleId, gameName, attemptCaptcha);

    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    console.log('[SCRAPE] Success:', result.stats);
    res.json(result);

  } catch (error) {
    console.error('[SCRAPE] Error:', error.message);

    res.status(500).json({
      error: error.message,
      url,
      timestamp: new Date().toISOString()
    });
  }
});

async function scrapeWithPuppeteer(url, titleId, gameName, attemptCaptcha) {
  const chromium = (await chromiumPromise).default;

  const browser = await puppeteerExtra.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: {
      width: 1920,
      height: 1080
    }
  });

  const page = await browser.newPage();

  // Stealth measures
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en']
    });
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    await new Promise(r => setTimeout(r, 2000));

    const pageTitle = await page.title().catch(() => 'Unknown');
    const finalUrl = page.url();

    // Extrai links com análise estrutural + diagnóstico
    const extractResult = await page.evaluate(() => {
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

      // Hosts finais conhecidos (aparecem no href OU no texto do link)
      const DOWNLOAD_HOST_HINTS = [
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
      ];

      // Encurtadores / intermediários usados pelo site (href real dos botões)
      const INTERMEDIATE_HOSTS = [
        'shrinkearn.com',
        'shrinkme.io',
        'linkvertise.com',
        'ouo.io',
        'adf.ly',
        'bit.ly',
        'cutt.ly'
      ];

      // Texto do link que é rótulo de host de download (comum no dlpsgame)
      const HOST_LABEL_RE = /^(mediafire|1fichier|1file|mega|gofile|pixeldrain|akia|akira|akirabox|viki|viking|vikingfile|dropbox|drive|google\s*drive|qiwi|katfile|mixdrop|workupload|mirror\s*\d*|part\s*\d+|link\s*\d+)$/i;

      // Texto de navegação / listas gerais → descartar
      const NAV_TEXT_RE = /\b(guide\s*download|tool\s*download|guide\s*download\s*game|daily\s*update|update\s*list\s*all\s*game|list\s*all\s*game|all\s*game\s*(ps[2345]|vita|psp)|ps[2345]\s*list|home|about|contact|privacy|terms|login|register|search|category|tag|archive|sitemap)\b/i;

      const DOWNLOAD_SIGNAL_RE = /\b(download|mirror|part\s*\d+|pkg|base|game|disc|iso|link|host)\b/i;
      const DLC_SIGNAL_RE = /\b(dlc|downloadable\s*content|season\s*pass|expansion|add[- ]?on|bonus\s*pack|costume\s*pack|character\s*pack)\b/i;
      const UPDATE_SIGNAL_RE = /\b(update|patch|ver(?:sion)?\.?\s*\d|v\d+\.\d+)\b/i;

      const anchors = Array.from(document.querySelectorAll('a[href]'));
      diag.totalAnchors = anchors.length;

      for (const a of anchors) {
        const href = a.href;
        if (!href || !href.startsWith('http') || seen.has(href)) continue;

        const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();

        // --- Sinais estruturais ---
        const inNav = !!a.closest(
          'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]'
        );
        const inMenuLike = !!a.closest(
          '[class*="menu"], [class*="nav"], [class*="sidebar"], [class*="footer"], [class*="header"], [class*="breadcrumb"], [id*="menu"], [id*="nav"], [id*="sidebar"], [id*="footer"], [id*="header"]'
        );
        // Área de conteúdo principal do post (Blogger / dlpsgame)
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

        // Contexto imediato curto
        const immediate = a.closest('li, td, th, p, span, div');
        let immediateText = '';
        if (immediate) {
          const raw = (immediate.innerText || immediate.textContent || '').replace(/\s+/g, ' ').trim();
          immediateText = raw.length > 160 ? raw.slice(0, 160) : raw;
        }

        let host = '';
        try {
          host = new URL(href).hostname.toLowerCase();
        } catch {
          continue;
        }

        const isKnownFinalHost = DOWNLOAD_HOST_HINTS.some(h => host.includes(h));
        const isIntermediate = INTERMEDIATE_HOSTS.some(h => host.includes(h));
        const hasFileExt = /\.(pkg|zip|rar|7z)(?:$|[?#])/i.test(href);
        const isHostLabel = HOST_LABEL_RE.test(text);
        const hasDownloadText = DOWNLOAD_SIGNAL_RE.test(text);
        const hasDlcOrUpdate = DLC_SIGNAL_RE.test(text) || UPDATE_SIGNAL_RE.test(text);
        // Texto do link cita um host conhecido (ex: "Mediafire", "1File", "Akia", "Viki")
        const textMentionsHost = DOWNLOAD_HOST_HINTS.some(h => text.toLowerCase().includes(h)) ||
          /akia|akira|viki|viking|1file/i.test(text);

        // Sinal mínimo aceitável
        const strongSignal =
          isKnownFinalHost ||
          hasFileExt ||
          isHostLabel ||
          textMentionsHost ||
          (isIntermediate && (isHostLabel || textMentionsHost || hasDownloadText || hasDlcOrUpdate || inContent)) ||
          hasDownloadText ||
          hasDlcOrUpdate;

        if (!strongSignal) {
          diag.discardedWeakSignal++;
          continue;
        }

        // Score
        let score = 0;
        if (isKnownFinalHost) score += 10;
        if (hasFileExt) score += 8;
        if (isHostLabel || textMentionsHost) score += 8;
        if (isIntermediate && inContent) score += 6;
        if (hasDownloadText) score += 4;
        if (hasDlcOrUpdate) score += 3;
        if (inContent) score += 4;
        if (immediateText && (DOWNLOAD_SIGNAL_RE.test(immediateText) || /mediafire|1fichier|akira|viking|mega/i.test(immediateText))) {
          score += 2;
        }

        // Penaliza mesmos-domínio sem sinal de arquivo
        try {
          if (new URL(href).origin === location.origin && !hasFileExt && !isKnownFinalHost) {
            score -= 5;
          }
        } catch {}

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
      return {
        links: results.slice(0, 60),
        diag
      };
    });

    const links = extractResult.links || [];
    const diag = extractResult.diag || {};

    console.log('[EXTRACT] diag:', JSON.stringify(diag));
    console.log('[EXTRACT] sample texts:', links.slice(0, 8).map(l => l.text));

    // Classifica usando principalmente o texto do próprio link
    const classified = {
      base: [],
      updates: [],
      dlcs: []
    };

    const DLC_RE = /\b(dlc|downloadable\s*content|season\s*pass|expansion|add[- ]?on|bonus\s*pack|costume\s*pack|character\s*pack)\b/i;
    const UPDATE_RE = /\b(update|patch|ver(?:sion)?\.?\s*\d|v\d+\.\d+)\b/i;
    const NAV_TEXT_RE = /\b(guide\s*download|tool\s*download|guide\s*download\s*game|daily\s*update|update\s*list\s*all\s*game|list\s*all\s*game|all\s*game\s*(ps[2345]|vita|psp)|ps[2345]\s*list)\b/i;

    for (const link of links) {
      const text = (link.text || '').toLowerCase();
      const href = (link.href || '').toLowerCase();
      const immediate = (link.immediateText || '').toLowerCase();

      if (NAV_TEXT_RE.test(text)) continue;

      const entry = {
        href: link.href,
        text: link.text,
        host: link.host
      };

      // Prioridade: sinais no próprio texto do <a>
      if (DLC_RE.test(text) || DLC_RE.test(href)) {
        classified.dlcs.push(entry);
        continue;
      }

      if (UPDATE_RE.test(text) || UPDATE_RE.test(href)) {
        if (!/list\s*all|daily\s*update|guide|tool/i.test(text)) {
          classified.updates.push(entry);
          continue;
        }
      }

      // Reforço com contexto imediato curto
      if (immediate.length > 0 && immediate.length < 120) {
        if (DLC_RE.test(immediate) && !/list\s*all|guide|tool/i.test(immediate)) {
          classified.dlcs.push(entry);
          continue;
        }
        if (UPDATE_RE.test(immediate) && !/list\s*all|daily\s*update|guide|tool/i.test(immediate)) {
          classified.updates.push(entry);
          continue;
        }
      }

      classified.base.push(entry);
    }

    await browser.close();

    const totalFound =
      classified.base.length +
      classified.updates.length +
      classified.dlcs.length;

    console.log('[CLASSIFY] base=%d updates=%d dlcs=%d', classified.base.length, classified.updates.length, classified.dlcs.length);

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
        dlcs: classified.dlcs.length
      },

      timestamp: new Date().toISOString()
    };

  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Limpa cache antigo a cada hora
setInterval(() => {
  const now = Date.now();

  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}, 1000 * 60 * 60);

app.listen(PORT, () => {
  console.log(`🚀 Scraper rodando na porta ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 4)}...`);
});
