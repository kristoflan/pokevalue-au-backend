require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

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

  // Sort oldest to newest
  const sorted = [...sales].sort((a, b) => new Date(a.date) - new Date(b.date));
  const prices = sorted.map(s => s.price);

  // Detect upward trend: compare avg of first half vs second half
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
  // Filter out bulk lots, graded cards, and non-singles
  const blacklist = [
    'lot', 'bulk', 'bundle', 'collection', 'psa', 'bgs', 'cgc', 'ace',
    'graded', 'reprint', 'proxy', 'fake', 'custom', 'x10', 'x20', 'x50',
    '10x', '20x', '50x', 'damaged', 'heavily played'
  ];
  const lower = title.toLowerCase();
  return !blacklist.some(word => lower.includes(word));
}

// ─── eBay Finding API — completed/sold listings ───────────────────────────────

async function fetchEbaySoldListings(cardName, cardNumber, setTotal, condition) {
  const token = await getEbayToken();

  // Build a targeted search query
  const conditionMap = {
    'NM': 'near mint',
    'LP': 'lightly played',
    'MP': 'moderately played',
    'HP': 'heavily played',
  };
  const conditionStr = conditionMap[condition] || condition || 'near mint';
  const query = `${cardName} ${cardNumber}/${setTotal} pokemon card ${conditionStr}`;

  const res = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
    params: {
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': process.env.EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': '',
      'keywords': query,
      'categoryId': '183454', // Pokémon Individual Cards category
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'LocatedIn',
      'itemFilter(1).value': 'AU',
      'itemFilter(2).name': 'Currency',
      'itemFilter(2).value': 'AUD',
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': '20',
    },
  });

  const items =
    res.data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

  // Filter and shape results
  const sales = items
    .filter(item => {
      const title = item.title?.[0] || '';
      const price = parseFloat(item.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.['__value__'] || 0);
      return cleanTitle(title) && price > 0.5 && price < 5000;
    })
    .map(item => ({
      title: item.title?.[0],
      price: Math.round(parseFloat(item.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.['__value__']) * 100) / 100,
      date: item.listingInfo?.[0]?.endTime?.[0],
      url: item.viewItemURL?.[0],
    }))
    .slice(0, 10); // Use last 10 max

  return sales;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'PokéValue AU backend is running' });
});

// eBay account deletion notification (required by eBay for compliance)
app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay account deletion notification received:', req.body);
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
    const sales = await fetchEbaySoldListings(name, number || '', total || '', condition || 'NM');

    if (!sales.length) {
      return res.json({
        success: true,
        cardName: name,
        message: 'No recent AU sold listings found for this card',
        result: null,
        sales: [],
      });
    }

    const result = calculatePrice(sales);

    return res.json({
      success: true,
      cardName: name,
      cardNumber: `${number}/${total}`,
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
