require('dotenv').config();
/**
 * Sneaker Price Search Backend
 * -----------------------------
 * Uses SerpAPI (Google Shopping engine) to get REAL prices from multiple
 * stores without triggering anti-bot blocks (403s). SerpAPI handles the
 * scraping infrastructure server-side.
 *
 * Free tier: https://serpapi.com — 100 searches/month free.
 *
 * ENV VARS REQUIRED:
 *   SERPAPI_KEY=your_key_here
 *   PORT=8080 (optional, Railway sets this automatically)
 */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const PORT = process.env.PORT || 8080;

if (!SERPAPI_KEY) {
  console.warn('WARNING: SERPAPI_KEY is not set. /api/search will fail until you add it.');
}

// ---- Simple in-memory cache (avoid burning free-tier quota on repeat searches) ----
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ---- Helpers ----

/**
 * Extracts a hostname like "nike.com" from a full URL, so we can match
 * SerpAPI results against the stores the user configured.
 */
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Cleans a price string like "$170.00" or "€149,99" into a float.
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr
    .replace(/[^\d.,]/g, '')
    .replace(/\.(?=\d{3},)/g, '') // remove thousands dots if euro-style
    .replace(',', '.');
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

/**
 * Calls SerpAPI's Google Shopping engine for a given query.
 * Returns the raw shopping_results array.
 */
async function fetchGoogleShoppingResults(query) {
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    api_key: SERPAPI_KEY,
    hl: 'en',
    gl: 'us', // change to 'es' / 'de' etc. if you want localized results
  });

  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`SerpAPI request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`SerpAPI error: ${data.error}`);
  }

  return data.shopping_results || [];
}

// ---- Routes ----

app.get('/', (req, res) => {
  res.json({
    name: 'Sneaker Price Search API',
    status: 'running',
    endpoints: {
      'POST /api/search': 'Search for sneaker prices across configured stores',
      'GET /api/health': 'Health check',
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    serpapi_configured: Boolean(SERPAPI_KEY),
    cache_size: cache.size,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/search
 * Body:
 * {
 *   "sneaker_name": "Air Jordan 1 Chicago",
 *   "size": "10.5",              // optional, informational only (Google Shopping doesn't filter by size)
 *   "stores": [                  // optional: filter results to only these store domains
 *     { "id": "nike", "name": "Nike", "domain": "nike.com" },
 *     { "id": "footlocker", "name": "Foot Locker", "domain": "footlocker.com" }
 *   ]
 * }
 *
 * If "stores" is omitted or empty, returns results from ALL stores Google Shopping finds.
 */
app.post('/api/search', async (req, res) => {
  try {
    const { sneaker_name, size, stores } = req.body;

    if (!sneaker_name || typeof sneaker_name !== 'string' || !sneaker_name.trim()) {
      return res.status(400).json({ success: false, error: 'sneaker_name is required' });
    }

    if (!SERPAPI_KEY) {
      return res.status(500).json({
        success: false,
        error: 'Server is missing SERPAPI_KEY. Add it to your environment variables.',
      });
    }

    const query = sneaker_name.trim();
    const cacheKey = `${query}::${size || ''}`.toLowerCase();

    let shoppingResults = getCached(cacheKey);
    let fromCache = true;

    if (!shoppingResults) {
      fromCache = false;
      shoppingResults = await fetchGoogleShoppingResults(query);
      setCached(cacheKey, shoppingResults);
    }

    // Build a lookup of allowed domains if the user configured specific stores
    const storeFilter = Array.isArray(stores) && stores.length > 0
      ? new Map(stores.map((s) => [s.domain?.replace(/^www\./, '').toLowerCase(), s]))
      : null;

    const results = shoppingResults
      .map((item) => {
        const link = item.product_link || item.link;
        const domain = item.source ? item.source.toLowerCase() : extractDomain(link);
        const price = item.extracted_price ?? parsePrice(item.price);

        return {
          store_name: item.source || 'Unknown store',
          domain,
          title: item.title,
          price,
          currency: item.currency || 'USD',
          product_url: link,
          thumbnail: item.thumbnail,
          rating: item.rating || null,
          available: true,
        };
      })
      .filter((item) => item.price !== null && item.product_url)
      // If the user configured specific stores, only keep matches.
      // Matching is loose (substring) since SerpAPI's "source" field isn't always a clean domain.
      .filter((item) => {
        if (!storeFilter) return true;
        const itemDomain = item.domain || '';
        for (const configuredDomain of storeFilter.keys()) {
          if (itemDomain.includes(configuredDomain.split('.')[0])) return true;
        }
        return false;
      })
      // Attach the user's store metadata (id, logo) when we have a match
      .map((item) => {
        if (!storeFilter) return item;
        for (const [configuredDomain, storeInfo] of storeFilter.entries()) {
          if ((item.domain || '').includes(configuredDomain.split('.')[0])) {
            return { ...item, store_id: storeInfo.id, store_logo: storeInfo.logo || null };
          }
        }
        return item;
      })
      .sort((a, b) => a.price - b.price);

    return res.json({
      success: true,
      sneaker_name: query,
      size: size || null,
      results,
      total_results: results.length,
      from_cache: fromCache,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`Sneaker Price Search API running on port ${PORT}`);
});
