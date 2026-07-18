function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = {};
  const textById = {};

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      scores[item.id] = (scores[item.id] || 0) + 1 / (k + rank + 1);
      textById[item.id] = item.text;
    });
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, text: textById[id], score }));
}

export { reciprocalRankFusion };
