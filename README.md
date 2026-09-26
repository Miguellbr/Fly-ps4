# PS4 Scraper (Fly.io)

Serviço Node.js/Express + Puppeteer que extrai e classifica links de páginas DLPSGame para o projeto **PS4 Library**.

## Arquitetura

```
Frontend (Vercel)
    ↓
/api/resolve  (proxy + validação)
    ↓
POST https://ps4-scraper.fly.dev/scrape
    ↓
scraper-service.js
  · Puppeteer + Chromium
  · extração estrutural
  · classificação base / updates / dlcs
  · resolução/validação de URLs
    ↓
JSON → Vercel → Frontend
```

O **Fly é a única fonte** de scraping. A Vercel não executa Puppeteer.

## Arquivos

| Arquivo | Função |
|---------|--------|
| `scraper-service.js` | Serviço completo |
| `package.json` | Dependências |
| `Dockerfile` | Imagem Node 18 + libs Chromium |
| `fly.toml` | App `ps4-scraper`, região `gru`, porta 8080 |

## Variáveis de ambiente

| Nome | Obrigatório | Descrição |
|------|-------------|-----------|
| `API_KEY` | sim (produção) | Valor esperado no header `x-api-key` |
| `PORT` | não | Default `8080` |

Configure o secret no Fly:

```bash
fly secrets set API_KEY=sua-chave-secreta -a ps4-scraper
```

**Nunca** coloque a API key no código ou no GitHub.

Na Vercel, use a variável `SCRAPER_API_KEY` com o **mesmo valor**.

## Endpoints

### `GET /`

```json
{ "status": "ok", "service": "PS4 Scraper", "version": "v3", "timestamp": "..." }
```

### `GET /health`

```json
{ "status": "healthy", "uptime": 123.4, "cacheSize": 0, "version": "v3" }
```

### `POST /scrape`

Headers: `Content-Type: application/json`, `x-api-key: <API_KEY>`

Body:

```json
{ "url": "https://dlpsgame.com/...", "titleId": "", "gameName": "" }
```

Resposta (resumo):

```json
{
  "success": true,
  "titleId": null,
  "game": { "title": "...", "sourceUrl": "..." },
  "links": {
    "base": [{ "href", "text", "host", "originalUrl", "resolved": { "success", "url", "error", "method" } }],
    "updates": [],
    "dlcs": []
  },
  "stats": { "found", "base", "updates", "dlcs", "resolved", "failed" },
  "cached": false,
  "timestamp": "..."
}
```

`resolved.success === true` só quando a URL passou por validação de destino final (host conhecido, não intermediário, não a página de origem).

## Cache

- Memória, TTL ~1 hora
- Chave inclui versão da lógica (`v3`) — mudança de algoritmo invalida resultados antigos
- Resposta inclui `cached: true|false`
- Logs: `[CACHE] HIT`, `[CACHE] MISS`, `[CACHE] EXPIRED`

## Logs

Cada requisição tem um id curto:

```
[REQ a1b2c3d4] [START] POST /scrape
[REQ a1b2c3d4] [CACHE] MISS
[REQ a1b2c3d4] [SCRAPE] goto ...
[REQ a1b2c3d4] [EXTRACT] diag {...}
[REQ a1b2c3d4] [RESOLVE] embedded candidate: ...
[REQ a1b2c3d4] [RESOLVE] final accepted (embedded) mediafire.com
[REQ a1b2c3d4] [CLASSIFY] base=12 updates=0 dlcs=0
[REQ a1b2c3d4] [RESPONSE] {...}
```

## Desenvolvimento local

```bash
npm ci
export API_KEY=dev-key
export PORT=8080
npm start
```

Chromium: em produção o serviço usa `@sparticuz/chromium` (imagem Docker). Localmente o mesmo pacote é usado.

## Deploy (Fly)

```bash
fly deploy -a ps4-scraper
```

Revise o diff antes de fazer deploy.

## Resolução de URLs

1. Host já final conhecido → valida e aceita  
2. URL embutida (ex. shrinkearn `?url=` base64) → extrai, **valida**, só então aceita  
3. Host intermediário → `page.goto` + redirects HTTP → valida resultado  
4. Qualquer falha de validação → `resolved.success = false`, `url = null`

Não há bypass de CAPTCHA, paywall ou autenticação de terceiros.
