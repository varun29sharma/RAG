function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = {}; // stores the accumulated RRF scores for every chunkID
  const textById = {}; //stores the chunk's text so it can be included in the final res

  /* we use ID bcuz... two retrievers return the same chunk (Say) 
     in such cases we need to recognize it as the same chunk and add 
     its contribution together instead of treating it as two different results
  */
  
  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      scores[item.id] = (scores[item.id] || 0) + 1 / (k + rank + 1);
      textById[item.id] = item.text;
    });
  }

  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, text: textById[id], score 
    //by using map, you are explicitly converting the pair into an object
}

export { reciprocalRankFusion };
