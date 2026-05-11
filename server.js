require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── eBay OAuth token (cached) ───────────────────────────────────────────────
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
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

// ─── Filtering helpers ────────────────────────────────────────────────────────

// Keywords that indicate a graded card (should be priced separately)
const GRADED_KEYWORDS = ['psa', 'bgs', 'cgc', 'ace', 'sgc', 'graded', 'grade'];

// Keywords that indicate junk listings we don't want
// This covers bulk lots, sealed product, display items, and non-card merch
const JUNK_KEYWORDS = [
  // Bulk / lots
  'lot', 'bulk', 'bundle', 'collection', 'x10', 'x20', 'x50', '10x', '20x', '50x',
  // Fakes / reprints
  'reprint', 'proxy', 'fake', 'custom',
  // Sealed product & packaging
  'booster', 'booster box', 'booster pack', 'display', 'display box',
  'etb', 'elite trainer', 'tin', 'tray', 'gift box', 'blister',
  'collection box', 'premium collection', 'special collection',
  // Extended art trays and promo products
  'extended art tray', 'extended art box', 'art tray',
  'promo box', 'promo pack', 'promo tin',
  // Accessories / non-cards
  'playmat', 'binder', 'sleeve', 'sleeves', 'deckbox', 'deck box',
  'album', 'folder', 'portfolio', 'figure', 'plush', 'pin', 'badge',
  'coin', 'dice', 'token', 'energy bundle', 'card bundle',
  // Condition flags we never want
  'damaged', 'heavily played',
];

function isGraded(title) {
  const lower = title.toLowerCase();
  return GRADED_KEYWORDS.some(k => lower.includes(k));
}

function isJunk(title) {
  const lower = title.toLowerCase();
  return JUNK_KEYWORDS.some(k => lower.includes(k));
}

// ─── Outlier removal using IQR method ────────────────────────────────────────
// Removes prices that are statistically too high or too low
// This is the same method used by financial pricing tools

function removeOutliers(prices) {
  if (prices.length < 4) return prices; // Not enough data to remove outliers

  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;

  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered = prices.filter(p => p >= lower && p <= upper);

  // Always keep at least 3 prices even if they're outliers
  return filtered.length >= 3 ? filtered : prices.slice(0, 3);
}

// ─── Smart pricing logic ──────────────────────────────────────────────────────

function calculatePrice(sales) {
  if (!sales.length) return null;

  // Sort oldest to newest by date
  const sorted = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date));
  const rawPrices = sorted.map(s => s.price);

  // Remove statistical outliers
  const cleanPrices = removeOutliers(rawPrices);
  console.log(`Prices before outlier removal: ${rawPrices}`);
  console.log(`Prices after outlier removal: ${cleanPrices}`);

  // Detect upward trend — compare avg of first half vs second half
  // Only flag as trending if we have at least 4 sales to compare
  let isTrending = false;
  if (cleanPrices.length >= 4) {
    const mid = Math.floor(cleanPrices.length / 2);
    const firstHalfAvg = cleanPrices.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const secondHalfAvg = cleanPrices.slice(mid).reduce((a, b) => a + b, 0) / (cleanPrices.length - mid);
    isTrending = secondHalfAvg / firstHalfAvg > 1.08; // 8% upward movement = trending
  }

  const average = cleanPrices.reduce((a, b) => a + b, 0) / cleanPrices.length;
  const latest = cleanPrices[cleanPrices.length - 1];
  const lowest = Math.min(...cleanPrices);
  const highest = Math.max(...cleanPrices);

  return {
    recommendedPrice: isTrending ? latest : average,
    average: Math.round(average * 100) / 100,
    latest: Math.round(latest * 100) / 100,
    lowest: Math.round(lowest * 100) / 100,
    highest: Math.round(highest * 100) / 100,
    isTrending,
    salesUsed: cleanPrices.length,
    outliersRemoved: rawPrices.length - cleanPrices.length,
    sales: sorted,
  };
}

// ─── eBay Browse API ──────────────────────────────────────────────────────────

// Build the base eBay search query for a card
function buildQuery(cardName, cardNumber, setTotal) {
  const numInt   = parseInt(cardNumber, 10);
  const totalInt = parseInt(setTotal,   10);
  const isSecretRare   = cardNumber && setTotal && !isNaN(numInt) && !isNaN(totalInt) && numInt > totalInt;
  const hasValidNumber = cardNumber && setTotal && !isNaN(numInt) && !isNaN(totalInt) && numInt <= totalInt;

  if (isSecretRare) {
    // Secret rare: number only without /total (e.g. "Umbreon 161 pokemon card")
    return { query: `${cardName} ${cardNumber} pokemon card`, isSecretRare, hasValidNumber };
  } else if (hasValidNumber) {
    // Normal card: full number/total (e.g. "Charizard 4/102 pokemon card")
    return { query: `${cardName} ${cardNumber}/${setTotal} pokemon card`, isSecretRare, hasValidNumber };
  }
  return { query: `${cardName} pokemon card`, isSecretRare: false, hasValidNumber: false };
}

// Mint keyword indicators in listing titles
const MINT_KEYWORDS   = ['gem mint', 'gem-mint', 'psa 10', 'perfect', ' mint ', 'mint/nm', 'nm/mint'];
const NM_KEYWORDS     = ['near mint', 'near-mint', 'nm/m', 'nm-m', ' nm ', 'excellent', 'lightly played', 'lp'];

function detectConditionFromTitle(title) {
  const lower = title.toLowerCase();
  if (MINT_KEYWORDS.some(k => lower.includes(k))) return 'mint';
  if (NM_KEYWORDS.some(k => lower.includes(k)))   return 'nm';
  return 'unknown'; // No condition keyword — could be either
}

async function fetchEbayListings(cardName, cardNumber, setTotal, token) {
  const { query: primaryQuery, isSecretRare, hasValidNumber } = buildQuery(cardName, cardNumber, setTotal);
  console.log('Primary eBay AU query:', primaryQuery);

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
          // Conditions: 1000=New, 2750=Like New, 3000=Very Good, 4000=Good
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
  console.log(`Primary query results: ${items.length}`);

  // Fallback: broaden to name-only if too few results
  if (items.length < 5 && hasValidNumber) {
    console.log('Too few results — trying broader name-only query');
    const broadItems = await fetchQuery(`${cardName} pokemon card`);
    const seen = new Set(items.map(i => i.itemId));
    broadItems.forEach(i => { if (!seen.has(i.itemId)) items.push(i); });
    console.log(`Total after merge: ${items.length}`);
  }

  // ── Filter and bucket into mint / nm / graded ────────────────────────────
  const mint    = [];
  const nm      = [];
  const unknown = [];
  const graded  = [];

  items.forEach(item => {
    const title = item.title || '';
    const price = Math.round(parseFloat(item.price?.value || 0) * 100) / 100;

    if (price < 0.50 || price > 10000) return;
    if (isJunk(title)) return;
    if (isSecretRare) {
      const firstWord = cardName.split(' ')[0].toLowerCase();
      if (!title.toLowerCase().includes(firstWord)) return;
    }

    const sale = {
      title,
      price,
      date: item.itemCreationDate || new Date().toISOString(),
      url:  item.itemWebUrl,
      condition: item.condition,
    };

    if (isGraded(title)) {
      graded.push(sale);
    } else {
      const cond = detectConditionFromTitle(title);
      if (cond === 'mint')    mint.push(sale);
      else if (cond === 'nm') nm.push(sale);
      else                    unknown.push(sale);
    }
  });

  // If we don't have enough condition-specific data, fold unknowns into NM
  // (NM is the most common condition for unspecified listings)
  const nmFinal   = [...nm,   ...unknown].slice(0, 10);
  const mintFinal = mint.slice(0, 10);

  console.log(`After filtering — Mint: ${mintFinal.length}, NM: ${nmFinal.length}, Graded: ${graded.length}`);

  return {
    mint:    mintFinal,
    nm:      nmFinal,
    graded:  graded.slice(0, 10),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'PokéValue AU backend is running', version: '1.1.0' });
});

// eBay challenge validation — GET
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  console.log('eBay GET hit. challenge_code:', challengeCode);

  if (!challengeCode) {
    return res.status(200).json({ status: 'endpoint live' });
  }

  const verificationToken = process.env.EBAY_VERIFICATION_TOKEN || 'pokevalue-au-ebay-verify-token-2026';
  const endpointUrl = process.env.EBAY_ENDPOINT_URL || 'https://pokevalue-au-backend.onrender.com/ebay/account-deletion';

  const hash = crypto.createHash('sha256');
  hash.update(challengeCode);
  hash.update(verificationToken);
  hash.update(endpointUrl);
  const responseHash = hash.digest('hex');

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ challengeResponse: responseHash });
});

// eBay deletion notification — POST
app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay POST deletion notification:', req.body);
  res.status(200).json({ acknowledged: true });
});

// Main pricing endpoint
// GET /price?name=Charizard&number=4&total=102&condition=NM
app.get('/price', async (req, res) => {
  const { name, number, total, condition } = req.query;

  if (!name) {
    return res.status(400).json({ error: 'Card name is required' });
  }

  try {
    const token = await getEbayToken();
    const { mint, nm, graded } = await fetchEbayListings(name, number || '', total || '', token);

    const mintResult   = calculatePrice(mint);
    const nmResult     = calculatePrice(nm);
    const gradedResult = calculatePrice(graded);

    if (!mintResult && !nmResult && !gradedResult) {
      return res.json({
        success: true,
        cardName: name,
        message: 'No recent AU listings found for this card',
        mint: null, nm: null, graded: null,
      });
    }

    const formatResult = (r) => r ? {
      recommendedPrice: Math.round(r.recommendedPrice * 100) / 100,
      average:          r.average,
      latest:           r.latest,
      lowest:           r.lowest,
      highest:          r.highest,
      isTrending:       r.isTrending,
      salesUsed:        r.salesUsed,
      outliersRemoved:  r.outliersRemoved,
      pricingMethod:    r.isTrending ? 'latest_sale_trending' : 'average',
      sales:            r.sales,
    } : null;

    return res.json({
      success: true,
      cardName: name,
      cardNumber: number && total ? `${number}/${total}` : '',
      mint:   formatResult(mintResult),
      nm:     formatResult(nmResult),
      graded: gradedResult ? {
        recommendedPrice: Math.round(gradedResult.recommendedPrice * 100) / 100,
        average:          gradedResult.average,
        salesUsed:        gradedResult.salesUsed,
        sales:            gradedResult.sales,
      } : null,
    });

  } catch (err) {
    console.error('eBay API error:', err?.response?.data || err.message);
    return res.status(500).json({
      error: 'Failed to fetch eBay data',
      detail: err?.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`PokéValue AU backend running on port ${PORT}`);
});
