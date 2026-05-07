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

// ─── Pricing logic ───────────────────────────────────────────────────────────

function calculatePrice(sales) {
  if (!sales.length) return null;

  const sorted = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date));
  const prices = sorted.map(s => s.price);

  const mid = Math.floor(prices.length / 2);
  const firstHalfAvg = prices.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const secondHalfAvg = prices.slice(mid).reduce((a, b) => a + b, 0) / (prices.length - mid);
  const isTrending = secondHalfAvg / firstHalfAvg > 1.08;

  const average = prices.reduce((a, b) => a + b, 0) / prices.length;
  const latest = prices[prices.length - 1];

  return {
    recommendedPrice: isTrending ? latest : average,
    average: Math.round(average * 100) / 100,
    latest: Math.round(latest * 100) / 100,
    isTrending,
    salesUsed: prices.length,
    sales: sorted,
  };
}

function cleanTitle(title) {
  const blacklist = [
    'lot', 'bulk', 'bundle', 'collection', 'psa', 'bgs', 'cgc', 'ace',
    'graded', 'reprint', 'proxy', 'fake', 'custom', 'x10', 'x20', 'x50',
    '10x', '20x', '50x', 'damaged', 'heavily played'
  ];
  const lower = title.toLowerCase();
  return !blacklist.some(word => lower.includes(word));
}

// ─── eBay Browse API — completed/sold listings ───────────────────────────────
// Browse API is the modern replacement for the legacy Finding API

async function fetchEbaySoldListings(cardName, cardNumber, setTotal, condition) {
  const token = await getEbayToken();

  const conditionMap = {
    'NM': 'near mint',
    'LP': 'lightly played',
    'MP': 'moderately played',
    'HP': 'heavily played',
  };
  const conditionStr = conditionMap[condition] || condition || 'near mint';

  // Build search query — card name + number/total + condition
  const query = `${cardName} ${cardNumber}/${setTotal} pokemon card ${conditionStr}`;
  console.log('Searching eBay AU for:', query);

  const res = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
      'Content-Type': 'application/json',
    },
    params: {
      q: query,
      filter: [
        'buyingOptions:{FIXED_PRICE}',
        'itemLocationCountry:AU',
        'price:[0.50..5000]',
        'priceCurrency:AUD',
      ].join(','),
      category_ids: '183454', // Pokemon Individual Cards
      limit: 20,
      sort: 'newlyListed',
    },
  });

  const items = res.data?.itemSummaries || [];
  console.log(`Found ${items.length} eBay AU listings`);

  const sales = items
    .filter(item => cleanTitle(item.title || ''))
    .map(item => ({
      title: item.title,
      price: Math.round(parseFloat(item.price?.value || 0) * 100) / 100,
      date: item.itemCreationDate || new Date().toISOString(),
      url: item.itemWebUrl,
      condition: item.condition,
    }))
    .filter(item => item.price > 0.5)
    .slice(0, 10);

  return sales;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PokéValue AU backend is running', api: 'eBay Browse API v1' });
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
    const sales = await fetchEbaySoldListings(
      name,
      number || '',
      total || '',
      condition || 'NM'
    );

    if (!sales.length) {
      return res.json({
        success: true,
        cardName: name,
        message: 'No recent AU listings found for this card',
        result: null,
        sales: [],
      });
    }

    const result = calculatePrice(sales);

    return res.json({
      success: true,
      cardName: name,
      cardNumber: number && total ? `${number}/${total}` : '',
      condition: condition || 'NM',
      result: {
        recommendedPrice: Math.round(result.recommendedPrice * 100) / 100,
        average: result.average,
        latest: result.latest,
        isTrending: result.isTrending,
        salesUsed: result.salesUsed,
        pricingMethod: result.isTrending ? 'latest_sale_trending' : 'average',
      },
      sales: result.sales,
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
