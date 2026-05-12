require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── eBay OAuth token (cached) ────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const res = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Filtering ────────────────────────────────────────────────────────────────
const GRADED_KEYWORDS = ['psa', 'bgs', 'cgc', 'ace', 'sgc', 'graded', 'grade'];
const JUNK_KEYWORDS = [
  // Bulk / lots / multi-card listings
  'lot', 'bulk', 'bundle', 'both', 'set of', 'pair of', 'combo',
  'x10', 'x20', 'x50', '10x', '20x', '50x',
  '2 cards', '3 cards', '4 cards', '5 cards', '6 cards', '7 cards', '8 cards',
  'full set', 'complete set', 'collection of', 'mixed lot',
  'various', 'assorted', 'selection of', 'choose from',
  'pick your', 'pick any', 'you choose', 'you pick',
  'all shown', 'as shown', 'as pictured', 'multiple',
  // Fakes / reprints / custom art
  'reprint', 'proxy', 'fake', 'custom',
  'framed', 'frame', 'canvas', 'print', 'poster', 'art print',
  'extended art', 'full art print', 'metal card', 'gold card',
  'custom card', 'fan art', 'orica', 'holo overlay',
  // Sealed BOXES and large products
  'booster box', 'display box',
  'booster pack',
  'gift box', 'blister pack',
  'collection box', 'premium collection', 'special collection',
  'promo box', 'promo tin',
  'theme deck', 'starter deck', 'battle deck',
  // Trays and display items
  'tray', 'art tray', 'extended art tray', 'extended art box',
  // Accessories
  'playmat', 'binder', 'sleeve', 'sleeves', 'deckbox', 'deck box',
  'album', 'folder', 'figure', 'plush', 'pin', 'coin', 'dice', 'token',
  // Condition flags
  'damaged', 'heavily played',
];

const MINT_KEYWORDS = ['gem mint', 'gem-mint', 'perfect', ' mint ', 'mint/nm', 'nm/mint'];
const NM_KEYWORDS   = ['near mint', 'near-mint', 'nm/m', 'nm-m', ' nm ', 'excellent', 'lightly played', ' lp '];

function isGraded(t) { return GRADED_KEYWORDS.some(k => t.toLowerCase().includes(k)); }
function isJunk(t)   { return JUNK_KEYWORDS.some(k => t.toLowerCase().includes(k)) || isSealedBox(t); }

function isSealedBox(title) {
  const lower = title.toLowerCase();
  const hasPromo = lower.includes('promo');
  if (lower.includes('elite trainer box') && !hasPromo) return true;
  if (lower.includes('etb') && lower.includes('sealed') && !hasPromo) return true;
  if (lower.includes('etb') && lower.includes('box') && !hasPromo) return true;
  if (lower.includes(' tin ') && !hasPromo) return true;
  if (lower.endsWith(' tin') && !hasPromo) return true;
  if (lower.includes('booster box')) return true;
  if (lower.includes('booster pack') && !hasPromo) return true;
  return false;
}

function detectCondition(t) {
  const l = t.toLowerCase();
  if (MINT_KEYWORDS.some(k => l.includes(k))) return 'mint';
  if (NM_KEYWORDS.some(k => l.includes(k)))   return 'nm';
  return 'unknown';
}

// ─── Title relevance check ────────────────────────────────────────────────────
function isTitleRelevant(title, cardName, cardNumber, setTotal) {
  const lower = title.toLowerCase();
  const nameWords = cardName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const nameMatch = nameWords.every(w => lower.includes(w));
  if (!nameMatch) return false;

  if (cardNumber) {
    const numInt   = parseInt(cardNumber, 10);
    const totalInt = parseInt(setTotal, 10);
    const hasTotal = setTotal && !isNaN(totalInt);
    const paddedNum = cardNumber.toString().padStart(3, '0');
    const numFormats = [
      cardNumber, paddedNum,
      hasTotal ? `${cardNumber}/${setTotal}` : null,
      hasTotal ? `${cardNumber} / ${setTotal}` : null,
      `#${cardNumber}`, `#${paddedNum}`,
      `no. ${cardNumber}`, `no.${cardNumber}`,
      `svp${cardNumber}`, `svp${paddedNum}`,
      `swsh${paddedNum}`, `sm${paddedNum}`, `xy${paddedNum}`,
    ].filter(Boolean);
    const numberFound = numFormats.some(fmt => lower.includes(fmt.toLowerCase()));
    if (!numberFound) return false;
  }
  return true;
}

// ─── Query builder ────────────────────────────────────────────────────────────
function buildQuery(cardName, cardNumber, setTotal) {
  const num   = parseInt(cardNumber, 10);
  const total = parseInt(setTotal,   10);
  const isSecret = cardNumber && setTotal && !isNaN(num) && !isNaN(total) && num > total;
  const hasNum   = cardNumber && setTotal && !isNaN(num) && !isNaN(total) && num <= total;
  const isPromo  = cardNumber && /[a-zA-Z]/.test(cardNumber);
  const isLargeSet = hasNum && total >= 200;

  if (isSecret || isPromo || isLargeSet) {
    return { query: cardNumber ? `${cardName} ${cardNumber}` : cardName, isSecret, hasNum, isPromo };
  }
  if (hasNum) {
    return { query: `${cardName} ${cardNumber}/${setTotal}`, isSecret, hasNum, isPromo: false };
  }
  return { query: cardName, isSecret: false, hasNum: false, isPromo: false };
}

// ─── Outlier removal (IQR) ────────────────────────────────────────────────────
function removeOutliers(prices) {
  if (prices.length < 4) return prices;
  const s  = [...prices].sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const f = prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  return f.length >= 3 ? f : prices.slice(0, 3);
}

// ─── Price calculator ─────────────────────────────────────────────────────────
function calculatePrice(sales) {
  if (!sales.length) return null;
  const sorted = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date));
  const raw    = sorted.map(s => s.price);
  const clean  = removeOutliers(raw);

  let isTrending = false;
  if (clean.length >= 4) {
    const mid  = Math.floor(clean.length / 2);
    const avg1 = clean.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const avg2 = clean.slice(mid).reduce((a, b) => a + b, 0) / (clean.length - mid);
    isTrending = avg2 / avg1 > 1.08;
  }

  const avg    = clean.reduce((a, b) => a + b, 0) / clean.length;
  const latest = clean[clean.length - 1];

  return {
    recommendedPrice: Math.round((isTrending ? latest : avg) * 100) / 100,
    average:          Math.round(avg    * 100) / 100,
    latest:           Math.round(latest * 100) / 100,
    lowest:           Math.round(Math.min(...clean) * 100) / 100,
    highest:          Math.round(Math.max(...clean) * 100) / 100,
    isTrending,
    salesUsed:        clean.length,
    outliersRemoved:  raw.length - clean.length,
    pricingMethod:    isTrending ? 'latest_sale_trending' : 'average',
    sales:            sorted,
  };
}

// ─── eBay Browse API — active listings ───────────────────────────────────────
async function fetchActiveListings(cardName, cardNumber, setTotal, token, isPromoOverride = false) {
  let { query, isSecret, hasNum, isPromo } = buildQuery(cardName, cardNumber, setTotal);
  const isJapanese = false; // handled separately per call

  if (isPromoOverride || isPromo) {
    query = `${cardName} ${cardNumber} promo`;
    console.log('Promo card detected — using promo query:', query);
  }

  console.log('Fetching active listings:', query);

  const fetch50 = async (q) => {
    const res = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
        'Content-Type': 'application/json',
      },
      params: {
        q,
        filter: [
          'buyingOptions:{FIXED_PRICE}',
          'itemLocationCountry:AU',
          'price:[0.50..10000]',
          'priceCurrency:AUD',
          'conditionIds:{1000|2750|3000|4000}',
        ].join(','),
        category_ids: '183454',
        limit: 50,
        sort: 'newlyListed',
      },
    });
    return res.data?.itemSummaries || [];
  };

  let items = await fetch50(query);
  if (items.length < 5 && hasNum) {
    const broad = await fetch50(`${cardName} pokemon card`);
    const seen  = new Set(items.map(i => i.itemId));
    broad.forEach(i => { if (!seen.has(i.itemId)) items.push(i); });
  }

  const mint = [], nm = [], unknown = [];

  items.forEach(item => {
    const title = item.title || '';
    const price = Math.round(parseFloat(item.price?.value || 0) * 100) / 100;
    if (price < 0.50 || price > 10000 || isJunk(title)) return;
    if (!isTitleRelevant(title, cardName, cardNumber, setTotal)) return;

    const sale = {
      title, price,
      date: item.itemCreationDate || new Date().toISOString(),
      url:  item.itemWebUrl,
    };

    const c = detectCondition(title);
    if (c === 'mint')    mint.push(sale);
    else if (c === 'nm') nm.push(sale);
    else                 unknown.push(sale);
  });

  const nmFinal = [...nm, ...unknown].slice(0, 10);
  console.log(`Active — Mint: ${mint.length}, NM: ${nmFinal.length}`);

  return {
    mint: mint.slice(0, 10),
    nm:   nmFinal,
  };
}

const fmt = r => r ? {
  recommendedPrice: r.recommendedPrice,
  average:          r.average,
  latest:           r.latest,
  lowest:           r.lowest,
  highest:          r.highest,
  isTrending:       r.isTrending,
  salesUsed:        r.salesUsed,
  outliersRemoved:  r.outliersRemoved,
  pricingMethod:    r.pricingMethod,
  sales:            r.sales,
} : null;

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'PokéValue AU running', version: '2.1.0' }));

app.get('/ebay/account-deletion', (req, res) => {
  const c = req.query.challenge_code;
  if (!c) return res.json({ status: 'live' });
  const vt  = process.env.EBAY_VERIFICATION_TOKEN || 'pokevalue-au-ebay-verify-token-2026';
  const ep  = process.env.EBAY_ENDPOINT_URL || 'https://pokevalue-au-backend.onrender.com/ebay/account-deletion';
  const h   = crypto.createHash('sha256');
  h.update(c); h.update(vt); h.update(ep);
  res.setHeader('Content-Type', 'application/json');
  return res.json({ challengeResponse: h.digest('hex') });
});
app.post('/ebay/account-deletion', (req, res) => res.json({ acknowledged: true }));

// ─── Main pricing endpoint ────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  const { name, number, total } = req.query;
  const isPromoParam  = req.query.isPromo === 'true';
  const isJapanese    = req.query.isJapanese === 'true';
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const token      = await getEbayToken();

    // For Japanese cards, override query to include 'japanese'
    let cardName = name;
    if (isJapanese) {
      const { query: baseQuery } = buildQuery(name, number || '', total || '');
      const jpQuery = `${name} ${number || ''} japanese`.trim();
      console.log('Japanese card eBay query:', jpQuery);
      // Temporarily patch name for fetchActiveListings
      cardName = `${name} japanese`;
    }

    const activeData = await fetchActiveListings(
      isJapanese ? `${name} japanese` : name,
      number || '',
      total || '',
      token,
      isPromoParam
    );

    return res.json({
      success:    true,
      cardName:   name,
      cardNumber: number && total ? `${number}/${total}` : '',
      active: {
        mint: fmt(calculatePrice(activeData.mint)),
        nm:   fmt(calculatePrice(activeData.nm)),
      },
    });
  } catch (err) {
    console.error('Pricing error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch pricing', detail: err?.message });
  }
});

// ── TCGdex diagnostic endpoint
app.get('/jp-test', async (req, res) => {
  const results = {};
  const tests = [
    ['en_name', 'https://api.tcgdex.net/v2/en/cards?name=umbreon'],
    ['ja_all',  'https://api.tcgdex.net/v2/ja/cards'],
    ['ja_name', 'https://api.tcgdex.net/v2/ja/cards?name=umbreon'],
    ['ja_pika',  'https://api.tcgdex.net/v2/ja/cards?name=pikachu'],
    ['ja_card',  'https://api.tcgdex.net/v2/ja/cards/swsh3-136'],
  ];
  for (const [key, url] of tests) {
    try {
      const r = await axios.get(url, { timeout: 10000, headers: { Accept: 'application/json' } });
      results[key] = { ok: true, status: r.status, count: Array.isArray(r.data) ? r.data.length : 'object', sample: Array.isArray(r.data) ? r.data[0] : r.data };
    } catch(e) {
      results[key] = { ok: false, status: e.response?.status, error: e.message, data: e.response?.data };
    }
  }
  return res.json(results);
});

// ── Japanese card search proxy ─────────────────────────────────────────────────
app.get('/jp-search', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const searchUrl = `https://api.tcgdex.net/v2/ja/cards?name=${encodeURIComponent(name)}&pagination[itemsPerPage]=24`;
    console.log('TCGdex search URL:', searchUrl);

    const searchRes = await axios.get(searchUrl, {
      timeout: 15000,
      headers: { 'Accept': 'application/json' },
    });

    const summaries = Array.isArray(searchRes.data) ? searchRes.data : [];
    console.log(`TCGdex found ${summaries.length} JP cards for "${name}"`);
    if (!summaries.length) return res.json([]);

    const details = await Promise.all(
      summaries.slice(0, 24).map(card =>
        axios.get(`https://api.tcgdex.net/v2/ja/cards/${card.id}`, {
          timeout: 10000,
          headers: { 'Accept': 'application/json' },
        })
          .then(r => r.data)
          .catch(e => { console.warn(`Failed to fetch card ${card.id}:`, e.message); return null; })
      )
    );

    const full = details.filter(Boolean);
    console.log(`Returning ${full.length} full JP card objects`);
    return res.json(full);
  } catch(err) {
    console.error('JP search error:', err.message);
    console.error('Response data:', err.response?.data);
    console.error('Response status:', err.response?.status);
    return res.status(500).json({
      error: 'Failed to fetch Japanese cards',
      detail: err.message,
      status: err.response?.status,
    });
  }
});

app.listen(PORT, () => console.log(`PokéValue AU backend running on port ${PORT}`));
