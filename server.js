require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

const GRADED_KEYWORDS = ['psa', 'bgs', 'cgc', 'ace', 'sgc', 'graded', 'grade'];
const JUNK_KEYWORDS = [
  'lot', 'bulk', 'bundle', 'both', 'set of', 'pair of', 'combo',
  'x10', 'x20', 'x50', '10x', '20x', '50x',
  '2 cards', '3 cards', '4 cards', '5 cards', '6 cards', '7 cards', '8 cards',
  'full set', 'complete set', 'collection of', 'mixed lot',
  'various', 'assorted', 'selection of', 'choose from',
  'pick your', 'pick any', 'you choose', 'you pick',
  'all shown', 'as shown', 'as pictured', 'multiple',
  'reprint', 'proxy', 'fake', 'custom',
  'framed', 'frame', 'canvas', 'print', 'poster', 'art print',
  'extended art', 'full art print', 'metal card', 'gold card',
  'custom card', 'fan art', 'orica', 'holo overlay',
  'booster box', 'display box', 'booster pack',
  'gift box', 'blister pack',
  'collection box', 'premium collection', 'special collection',
  'promo box', 'promo tin',
  'theme deck', 'starter deck', 'battle deck',
  'tray', 'art tray', 'extended art tray', 'extended art box',
  'playmat', 'binder', 'sleeve', 'sleeves', 'deckbox', 'deck box',
  'album', 'folder', 'figure', 'plush', 'pin', 'coin', 'dice', 'token',
  'damaged', 'heavily played',
];
const MINT_KEYWORDS  = ['gem mint', 'gem-mint', 'perfect', ' mint ', 'mint/nm', 'nm/mint'];
const NM_KEYWORDS    = ['near mint', 'near-mint', 'nm/m', 'nm-m', ' nm ', 'excellent', 'lightly played', ' lp '];
const STAMP_KEYWORDS = ['stamp', 'pokemon center', 'pokecenter', 'pc stamp'];
const PROMO_PREFIXES = ['svp', 'swshp', 'smp', 'xyp', 'bwp', 'np', 'dp'];

function isGraded(t) { return GRADED_KEYWORDS.some(k => t.toLowerCase().includes(k)); }
function hasStampKeyword(t) { return STAMP_KEYWORDS.some(k => t.toLowerCase().includes(k)); }

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

function isJunk(t) { return JUNK_KEYWORDS.some(k => t.toLowerCase().includes(k)) || isSealedBox(t); }

function detectCondition(t) {
  const l = t.toLowerCase();
  if (MINT_KEYWORDS.some(k => l.includes(k))) return 'mint';
  if (NM_KEYWORDS.some(k => l.includes(k)))   return 'nm';
  return 'unknown';
}

function isTitleRelevant(title, cardName, cardNumber, setTotal) {
  const lower     = title.toLowerCase();
  const nameWords = cardName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!nameWords.every(w => lower.includes(w))) return false;
  if (cardNumber) {
    const numInt       = parseInt(cardNumber, 10);
    const totalInt     = parseInt(setTotal, 10);
    const hasTotal     = setTotal && !isNaN(totalInt);
    const hasNumeric   = !isNaN(numInt);
    const padded       = hasNumeric ? String(numInt).padStart(3, '0') : cardNumber;
    const formats = [
      cardNumber,
      padded !== cardNumber ? padded : null,
      hasTotal ? `${cardNumber}/${setTotal}` : null,
      hasTotal ? `${cardNumber} / ${setTotal}` : null,
      !hasNumeric ? `${cardNumber}/${cardNumber}` : null,
      `#${cardNumber}`,
      hasNumeric && padded !== cardNumber ? `#${padded}` : null,
      `no. ${cardNumber}`, `no.${cardNumber}`,
      `svp${cardNumber}`, `svp${padded}`,
      `swsh${padded}`, `sm${padded}`, `xy${padded}`,
    ].filter(Boolean);
    if (!formats.some(f => lower.includes(f.toLowerCase()))) return false;
  }
  return true;
}

function buildQuery(cardName, cardNumber, setTotal) {
  const num    = parseInt(cardNumber, 10);
  const total  = parseInt(setTotal, 10);
  const isSecret   = cardNumber && setTotal && !isNaN(num) && !isNaN(total) && num > total;
  const hasNum     = cardNumber && setTotal && !isNaN(num) && !isNaN(total) && num <= total;
  const isLargeSet = hasNum && total >= 200;
  const numLower   = (cardNumber || '').toLowerCase();
  const isPromo    = cardNumber && PROMO_PREFIXES.some(p => numLower.startsWith(p));
  if (isSecret || isLargeSet || (cardNumber && /[a-zA-Z]/.test(cardNumber))) {
    return { query: cardNumber ? `${cardName} ${cardNumber}` : cardName, isSecret, hasNum, isPromo };
  }
  if (hasNum) return { query: `${cardName} ${cardNumber}/${setTotal}`, isSecret, hasNum, isPromo: false };
  return { query: cardName, isSecret: false, hasNum: false, isPromo: false };
}

function removeOutliers(prices) {
  if (prices.length < 4) return prices;
  const s = [...prices].sort((a, b) => a - b);
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  const iqr = q3 - q1;
  const f = prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  return f.length >= 3 ? f : prices.slice(0, 3);
}

function calculatePrice(sales) {
  if (!sales || !sales.length) return null;
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
    isTrending, salesUsed: clean.length,
    outliersRemoved:  raw.length - clean.length,
    pricingMethod:    isTrending ? 'latest_sale_trending' : 'average',
    sales: sorted,
  };
}

async function fetchActiveListings(cardName, cardNumber, setTotal, token, isPromoOverride = false, stampVariant = 'none', gradeFilter = null) {
  let { query, isSecret, hasNum, isPromo } = buildQuery(cardName, cardNumber, setTotal);

  if (gradeFilter) {
    query = `${cardName} ${cardNumber} ${gradeFilter.company} ${gradeFilter.value}`.trim();
    console.log('Graded query:', query);
  } else if (isPromoOverride || isPromo) {
    query = stampVariant === 'pokemon_center'
      ? `${cardName} ${cardNumber} pokemon center stamp`
      : `${cardName} ${cardNumber} promo`;
    console.log('Promo query:', query);
  }

  console.log('Fetching active listings:', query);

  const fetch50 = async (q) => {
    const res = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU', 'Content-Type': 'application/json' },
      params: {
        q,
        filter: ['buyingOptions:{FIXED_PRICE}','itemLocationCountry:AU','price:[0.50..10000]','priceCurrency:AUD','conditionIds:{1000|2750|3000|4000}'].join(','),
        category_ids: '183454', limit: 50, sort: 'newlyListed',
      },
    });
    return res.data?.itemSummaries || [];
  };

  let items = await fetch50(query);
  if (items.length < 5) {
    const broad = gradeFilter ? `${cardName} ${gradeFilter.company} ${gradeFilter.value}` : cardName;
    const more  = await fetch50(broad);
    const seen  = new Set(items.map(i => i.itemId));
    more.forEach(i => { if (!seen.has(i.itemId)) items.push(i); });
  }

  if (gradeFilter) {
    const graded = [];
    const co = gradeFilter.company.toLowerCase();
    const gv = gradeFilter.value.toLowerCase();
    items.forEach(item => {
      const title = item.title || '';
      const tl    = title.toLowerCase();
      const price = Math.round(parseFloat(item.price?.value || 0) * 100) / 100;
      if (price < 0.50 || price > 10000 || isJunk(title)) return;
      if (!isTitleRelevant(title, cardName, cardNumber, setTotal)) return;
      if (!tl.includes(co)) return;
      const patterns = [`${co} ${gv}`,`${co}${gv}`,`${co}-${gv}`,`${co} grade ${gv}`,`${co} gem mt ${gv}`,`${co} gem mint ${gv}`];
      if (!patterns.some(p => tl.includes(p))) return;
      graded.push({ title, price, date: item.itemCreationDate || new Date().toISOString(), url: item.itemWebUrl });
    });
    console.log(`Graded — ${gradeFilter.company} ${gradeFilter.value}: ${graded.length}`);
    return { graded: graded.slice(0, 10) };
  }

  const mint = [], nm = [], unknown = [];
  const cleanName = cardName.replace(' japanese','').replace(' promo','');
  items.forEach(item => {
    const title = item.title || '';
    const price = Math.round(parseFloat(item.price?.value || 0) * 100) / 100;
    if (price < 0.50 || price > 10000 || isJunk(title) || isGraded(title)) return;
    if (!isTitleRelevant(title, cleanName, cardNumber, setTotal)) return;
    const titleHasStamp = hasStampKeyword(title);
    if (stampVariant === 'pokemon_center' && !titleHasStamp) return;
    if (stampVariant === 'none' && titleHasStamp) return;
    const sale = { title, price, date: item.itemCreationDate || new Date().toISOString(), url: item.itemWebUrl };
    const c = detectCondition(title);
    if (c === 'mint') mint.push(sale);
    else if (c === 'nm') nm.push(sale);
    else unknown.push(sale);
  });

  const nmFinal = [...nm, ...unknown].slice(0, 10);
  console.log(`Active — Mint: ${mint.length}, NM: ${nmFinal.length}`);
  return { mint: mint.slice(0, 10), nm: nmFinal };
}

const fmt = r => r ? {
  recommendedPrice: r.recommendedPrice, average: r.average, latest: r.latest,
  lowest: r.lowest, highest: r.highest, isTrending: r.isTrending,
  salesUsed: r.salesUsed, outliersRemoved: r.outliersRemoved,
  pricingMethod: r.pricingMethod, sales: r.sales,
} : null;

app.get('/', (req, res) => res.json({ status: 'PokéValue AU running', version: '3.1.0' }));

app.get('/ebay/account-deletion', (req, res) => {
  const c = req.query.challenge_code;
  if (!c) return res.json({ status: 'live' });
  const vt = process.env.EBAY_VERIFICATION_TOKEN || 'pokevalue-au-ebay-verify-token-2026';
  const ep = process.env.EBAY_ENDPOINT_URL || 'https://pokevalue-au-backend.onrender.com/ebay/account-deletion';
  const h  = crypto.createHash('sha256');
  h.update(c); h.update(vt); h.update(ep);
  res.setHeader('Content-Type', 'application/json');
  return res.json({ challengeResponse: h.digest('hex') });
});
app.post('/ebay/account-deletion', (req, res) => res.json({ acknowledged: true }));

app.get('/price', async (req, res) => {
  const { name, number, total } = req.query;
  const isPromoParam = req.query.isPromo === 'true';
  const stampVariant = req.query.stamp || 'none';
  const gradeCompany = req.query.gradeCompany || null;
  const gradeValue   = req.query.gradeValue   || null;
  const gradeFilter  = gradeCompany && gradeValue ? { company: gradeCompany, value: gradeValue } : null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const token      = await getEbayToken();
    const activeData = await fetchActiveListings(name, number || '', total || '', token, isPromoParam, stampVariant, gradeFilter);
    const active = gradeFilter
      ? { graded: fmt(calculatePrice(activeData.graded || [])) }
      : { mint: fmt(calculatePrice(activeData.mint || [])), nm: fmt(calculatePrice(activeData.nm || [])) };
    return res.json({ success: true, cardName: name, cardNumber: number && total ? `${number}/${total}` : '', stamp: stampVariant, gradeFilter, active });
  } catch (err) {
    console.error('Pricing error:', err?.message);
    return res.status(500).json({ error: 'Failed to fetch pricing', detail: err?.message });
  }
});

app.listen(PORT, () => console.log(`PokéValue AU backend running on port ${PORT}`));