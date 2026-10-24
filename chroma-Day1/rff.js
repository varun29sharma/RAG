function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = {}; // stores the accumulated RRF scores for every chunkID
  const textById = {}; //stores the chunk's text so it can be included in the final res
  const metadataById = {};

  /* we use ID bcuz... two retrievers return the same chunk (Say) 
     in such cases we need to recognize it as the same chunk and add 
     its contribution together instead of treating it as two different results
  */

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      //if the item itself doesnt exist or the id is null just return back
      if (!item || item.id == null) return;

      scores[item.id] = (scores[item.id] || 0) + 1 / (k + rank + 1);
      /* 
        here we are getting the scores and the text's by id and if they by chance tend to 
        contain null/undefined values we use and || operator to make sure that the undefined
        or null values aren't taken into consdieration
      */
      textById[item.id] = item.text ?? textById[item.id];
      /* 
        here we are creating an object which fetches the metadata
        i.e the source and the page... which are used in citation
      */
      metadataById[item.id] = {
        source: item.source ?? metadataById[item.id]?.source,
        page: item.page ?? metadataById[item.id]?.page,
      };
    });
  }
  // finally we also add the metadata to the result
  const res = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({
      id,
      text: textById[id],
      ...metadataById[id],
      score,
    }));

  //console.log(res);
  return res;
}

export { reciprocalRankFusion };
