async function rerankWithCohere(query, candidates, topN = 3) {
  // candidates: [{ id, text }, ...] — your RRF-fused top 10-15 results
  const response = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "rerank-v3.5",
      query,
      documents: candidates.map((c) => c.text),
      top_n: topN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Cohere rerank failed: ${response.status}`);
  }

  const data = await response.json();
  // data.results: [{ index, relevance_score }, ...] already sorted best-first
  return data.results.map((r) => ({
    ...candidates[r.index],
    relevanceScore: r.relevance_score,
  }));
}

module.exports = { rerankWithCohere };
