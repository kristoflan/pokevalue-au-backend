require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const crypto   = require('crypto');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── eBay OAuth token (cached) ────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString('base64');
  const res = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    { headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Filtering helpers ────────────────────────────────────────────────────────
const GRADED_KEYWORDS = ['psa', 'bgs', 'cgc', 'ace', 'sgc', 'graded', 'grade'];
const JUNK_KEYWORDS = [
  'lot', 'bulk', 'bundle', 'collection', 'x10', 'x20', 'x50', '10x', '20x', '50x',
  'reprint', 'proxy', 'fake', 'custom',
  'booster', 'booster box', 'booster pack', 'display', 'display box',
  'etb', 'elite trainer', 'tin', 'tray', 'gift box', 'blister',
  'collection box', 'premium collection', 'special collection',
  'extended art tray', 'extended art box', 'art tray',
  'promo box', 'promo pack', 'promo tin',
  'playmat', 'binder', 'sleeve', 'sleeves', 'deckbox', 'deck box',
  'album', 'folder', 'portfolio', 'figure', 'plush', 'pin', 'badge',
  'coin', 'dice', 'token', 'energy bundle', 'card bundle',
  'damaged', 'heavily played',
];

const MINT_KEYWORDS = ['gem mint', 'gem-mint', 'psa 10', 'perfect', ' mint ', 'mint/nm', 'nm/mint'];
const NM_KEYWORDS   = ['near mint', 'near-mint', 'nm/m', 'nm-m', ' nm ', 'excellent', 'lightly played', 'lp'];

function isGraded(title) { return GRADED_KEYWORDS.some(k => title.toLowerCase().includes(k)); }
function isJunk(title)   { return JUNK_KEYWORDS.some(k => title.toLowerCase().includes(k)); }

function detectCondition(title) {
  const lower = title.toLowerCase();
  if (MINT_KEYWORDS.some(k => lower.includes(k))) return 'mint';
  if (NM_KEYWORDS.some(k => lower.includes(k)))   return 'nm';
  return 'unknown';
}

// ─── Query builder ────────────────────────────────────────────────────────────
function buildQuery(cardName, cardNumber, setTotal) {
  const numInt   = parseInt(cardNumber, 10);
  const totalInt = parseInt(setTotal,   10);
  const isSecret = cardNumber && setTotal && !isNaN(numInt) && !isNaN(totalInt) && numInt > totalInt;
  const hasNum   = cardNumber && setTotal && !isNaN(numInt) && !isNaN(totalInt) && numInt <= totalInt;

  let query;
  if (isSecret)   query = `${cardName} ${cardNumber} pokemon card`;
  else if (hasNum) query = `${cardName} ${cardNumber}/${setTotal} pokemon card`;
  else             query = `${cardName} pokemon card`;

  return { query, isSecret, hasNum };
}

// ─── Outlier removal (IQR) ────────────────────────────────────────────────────
function removeOutliers(prices) {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1  = sorted[Math.floor(sorted.length * 0.25)];
  const q3  = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const filtered = prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  return filtered.length >= 3 ? filtered : prices.slice(0, 3);
}

// ─── Pricing calculator ───────────────────────────────────────────────────────
function calculatePrice(sales) {
  if (!sales.length) return null;
  const sorted    = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date));
  const rawPrices = sorted.map(s => s.price);
  const clean     = removeOutliers(rawPrices);

  let isTrending = false;
  if (clean.length >= 4) {
    const mid  = Math.floor(clean.length / 2);
    const avg1 = clean.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const avg2 = clean.slice(mid).reduce((a, b) => a + b, 0) / (clean.length - mid);
    isTrending = avg2 / avg1 > 1.08;
  }

  const average = clean.reduce((a, b) => a + b, 0) / clean.length;
  const latest  = clean[clean.length - 1];

  return {
    recommendedPrice:  Math.round((isTrending ? latest : average) * 100) / 100,
    average:           Math.round(average * 100) / 100,
    latest:            Math.round(latest  * 100) / 100,
    lowest:            Math.round(Math.min(...clean) * 100) / 100,
    highest:           Math.round(Math.max(...clean) * 100) / 100,
    isTrending,
    salesUsed:         clean.length,
    outliersRemoved:   rawPrices.length - clean.length,
    pricingMethod:     isTrending ? 'latest_sale_trending' : 'average',
    sales:             sorted,
  };
}

// ─── SOLD LISTINGS — Puppeteer scraper ───────────────────────────────────────
// Scrapes eBay AU completed/sold listings page directly.
// Targets last 30 days, aiming for at least 5 sold results.
// If fewer than 5 found in 30 days, expands to 90 days automatically.

async function scrapeEbaySoldListings(cardName, cardNumber, setTotal) {
  const { query, isSecret, hasNum } = buildQuery(cardName, cardNumber, setTotal);
  const encodedQuery = encodeURIComponent(query);

  // eBay AU sold listings URL — LH_Sold=1&LH_Complete=1 shows sold items
  // _sop=13 sorts by most recently ended first
  const url = `https://www.ebay.com.au/sch/i.html?_nkw=${encodedQuery}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3&_sop=13&_ipg=60&Category0=&rt=nc&_trksid=p4429486.m3563.l1313`;

  console.log('Scraping eBay AU sold listings:', url);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    // Set AU locale headers so eBay serves AUD prices
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en;q=0.9' });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for search results to appear
    await page.waitForSelector('.s-item', { timeout: 15000 }).catch(() => {});

    // Extract sold listing data from the page
    const items = await page.evaluate(() => {
      const results = [];
      const cards   = document.querySelectorAll('.s-item');

      cards.forEach(card => {
        try {
          const titleEl  = card.querySelector('.s-item__title');
          const priceEl  = card.querySelector('.s-item__price');
          const dateEl   = card.querySelector('.s-item__ended-date, .s-item__listingDate');
          const linkEl   = card.querySelector('a.s-item__link');

          if (!titleEl || !priceEl) return;

          const title = titleEl.textContent.trim();
          if (title === 'Shop on eBay' || title.toLowerCase().includes('shop on ebay')) return;

          // Parse price — handle ranges by taking the lower value
          const rawPrice = priceEl.textContent.trim();
          const priceMatch = rawPrice.match(/[\d,]+\.?\d*/);
          if (!priceMatch) return;
          const price = parseFloat(priceMatch[0].replace(/,/g, ''));
          if (!price || price < 0.5) return;

          // Parse sold date
          const dateText = dateEl ? dateEl.textContent.trim() : '';
          const url = linkEl ? linkEl.href : '';

          results.push({ title, price, dateText, url });
        } catch(e) {}
      });

      return results;
    });

    console.log(`Scraped ${items.length} sold listings from eBay AU`);

    // ── Filter and parse dates ────────────────────────────────────────────
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const processed = items
      .filter(item => !isJunk(item.title) && !isGraded(item.title))
      .filter(item => {
        if (isSecret) {
          const firstWord = cardName.split(' ')[0].toLowerCase();
          return item.title.toLowerCase().includes(firstWord);
        }
        return true;
      })
      .map(item => {
        // Try to parse the date from eBay's format (e.g. "Sold  23 Apr 2025")
        const cleaned = item.dateText.replace(/sold/i, '').trim();
        let date = new Date(cleaned);
        if (isNaN(date.getTime())) date = new Date(); // fallback to now

        return {
          title:     item.title,
          price:     item.price,
          date:      date.toISOString(),
          url:       item.url,
          condition: detectCondition(item.title),
        };
      });

    // ── Apply 30-day window, expand to 90 if too few ──────────────────────
    const within30 = processed.filter(i => new Date(i.date) >= thirtyDaysAgo);
    const within90 = processed.filter(i => new Date(i.date) >= ninetyDaysAgo);

    let finalSales;
    let windowUsed;

    if (within30.length >= 5) {
      // Enough data in 30 days — use last 5
      finalSales = within30.slice(0, 5);
      windowUsed = '30 days';
    } else if (within90.length >= 3) {
      // Expand to 90 days
      finalSales = within90.slice(0, 10);
      windowUsed = '90 days';
      console.log(`Only ${within30.length} sales in 30 days — expanded to 90 days (${within90.length} found)`);
    } else {
      // Just use whatever we have
      finalSales = processed.slice(0, 10);
      windowUsed = 'all available';
      console.log(`Sparse data — using all ${processed.length} available sold listings`);
    }

    // ── Bucket by condition ───────────────────────────────────────────────
    const mint    = finalSales.filter(s => s.condition === 'mint');
    const nm      = finalSales.filter(s => s.condition === 'nm');
    const unknown = finalSales.filter(s => s.condition === 'unknown');
    const nmFinal = [...nm, ...unknown]; // Unknowns fold into NM

    console.log(`Sold — Mint: ${mint.length}, NM: ${nmFinal.length} (window: ${windowUsed})`);

    return { mint, nm: nmFinal, windowUsed, totalFound: processed.length };

  } finally {
    await browser.close();
  }
}

// ─── ACTIVE LISTINGS — eBay Browse API ───────────────────────────────────────
// Keeps the existing Browse API for current asking prices.

async function fetchActiveListings(cardName, cardNumber, setTotal, token) {
  const { query: primaryQuery, isSecret, hasNum } = buildQuery(cardName, cardNumber, setTotal);
  console.log('Fetching active listings:', primaryQuery);

  const fetchQuery = async (q) => {
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

  let items = await fetchQuery(primaryQuery);
  if (items.length < 5 && hasNum) {
    const broad = await fetchQuery(`${cardName} pokemon card`);
    const seen  = new Set(items.map(i => i.itemId));
    broad.forEach(i => { if (!seen.has(i.itemId)) items.push(i); });
  }

  const ungraded = [];
  const graded   = [];

  items.forEach(item => {
    const title = item.title || '';
    const price = Math.round(parseFloat(item.price?.value || 0) * 100) / 100;
    if (price < 0.50 || price > 10000 || isJunk(title)) return;
    if (isSecret) {
      if (!title.toLowerCase().includes(cardName.split(' ')[0].toLowerCase())) return;
    }
    const sale = { title, price, date: item.itemCreationDate || new Date().toISOString(), url: item.itemWebUrl, condition: item.condition };
    isGraded(title) ? graded.push(sale) : ungraded.push(sale);
  });

  // Bucket active listings by condition
  const mint    = ungraded.filter(s => detectCondition(s.title) === 'mint').slice(0, 10);
  const nm      = ungraded.filter(s => detectCondition(s.title) !== 'mint').slice(0, 10);

  console.log(`Active — Mint: ${mint.length}, NM: ${nm.length}, Graded: ${graded.length}`);
  return { mint, nm, graded: graded.slice(0, 10) };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'PokéValue AU backend running', version: '2.0.0' });
});

// eBay challenge validation
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(200).json({ status: 'endpoint live' });
  const token    = process.env.EBAY_VERIFICATION_TOKEN || 'pokevalue-au-ebay-verify-token-2026';
  const endpoint = process.env.EBAY_ENDPOINT_URL || 'https://pokevalue-au-backend.onrender.com/ebay/account-deletion';
  const hash     = crypto.createHash('sha256');
  hash.update(challengeCode); hash.update(token); hash.update(endpoint);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ challengeResponse: hash.digest('hex') });
});

app.post('/ebay/account-deletion', (req, res) => {
  res.status(200).json({ acknowledged: true });
});

// ─── Main pricing endpoint ────────────────────────────────────────────────────
// Returns both sold (scraped) and active (Browse API) data
// GET /price?name=Charizard&number=4&total=102
app.get('/price', async (req, res) => {
  const { name, number, total } = req.query;
  if (!name) return res.status(400).json({ error: 'Card name is required' });

  try {
    // Run sold scrape and active listings fetch in parallel
    const [soldData, token] = await Promise.all([
      scrapeEbaySoldListings(name, number || '', total || ''),
      getEbayToken(),
    ]);

    const activeData = await fetchActiveListings(name, number || '', total || '', token);

    const fmt = (r) => r ? {
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

    return res.json({
      success: true,
      cardName: name,
      cardNumber: number && total ? `${number}/${total}` : '',

      // ── Sold listings (scraped — actual prices paid) ───────────────────
      sold: {
        windowUsed:  soldData.windowUsed,
        totalFound:  soldData.totalFound,
        mint:        fmt(calculatePrice(soldData.mint)),
        nm:          fmt(calculatePrice(soldData.nm)),
      },

      // ── Active listings (Browse API — current asking prices) ──────────
      active: {
        mint:   fmt(calculatePrice(activeData.mint)),
        nm:     fmt(calculatePrice(activeData.nm)),
        graded: activeData.graded.length ? {
          recommendedPrice: fmt(calculatePrice(activeData.graded))?.recommendedPrice,
          average:          fmt(calculatePrice(activeData.graded))?.average,
          salesUsed:        fmt(calculatePrice(activeData.graded))?.salesUsed,
          sales:            activeData.graded,
        } : null,
      },
    });

  } catch (err) {
    console.error('Pricing error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch pricing data', detail: err?.message });
  }
});

app.listen(PORT, () => console.log(`PokéValue AU backend running on port ${PORT}`));
