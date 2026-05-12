// ── Japanese card search proxy ─────────────────────────────────────────────────
app.get('/jp-search', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    // Step 1: Search by name — returns JP card summaries with correct JP IDs
    const searchUrl = `https://api.tcgdex.net/v2/ja/cards?name=${encodeURIComponent(name)}&pagination[itemsPerPage]=24`;
    console.log('TCGdex JP search:', searchUrl);

    const searchRes = await axios.get(searchUrl, {
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });

    const summaries = Array.isArray(searchRes.data) ? searchRes.data : [];
    console.log(`Found ${summaries.length} JP cards for "${name}"`);
    if (!summaries.length) return res.json([]);

    // Step 2: Fetch full details using JP card IDs from the JP endpoint
    const details = await Promise.all(
      summaries.slice(0, 24).map(async card => {
        try {
          const r = await axios.get(`https://api.tcgdex.net/v2/ja/cards/${card.id}`, {
            timeout: 10000,
            headers: { Accept: 'application/json' },
          });
          return r.data;
        } catch(e) {
          // Fall back to summary if full details fail
          console.warn(`Full details failed for ${card.id} — using summary`);
          return {
            id:      card.id,
            localId: card.localId,
            name:    card.name,
            image:   card.image || null,
          };
        }
      })
    );

    const full = details.filter(Boolean);
    console.log(`Returning ${full.length} JP card objects`);
    return res.json(full);

  } catch(err) {
    console.error('JP search error:', err.message, err.response?.status);
    return res.status(500).json({
      error:  'Failed to fetch Japanese cards',
      detail: err.message,
      status: err.response?.status,
    });
  }
});
