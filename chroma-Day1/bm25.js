function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

class BM25Index {
  constructor(documents, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.documents = documents;
    this.docTokens = documents.map((doc) =>
      tokenize(doc.text || doc.pageContent),
    );
    this.docLengths = this.docTokens.map((t) => t.length);
    this.avgDocLength =
      this.docLengths.reduce((a, b) => a + b, 0) / this.docLengths.length;
    this.N = documents.length;
    this.docFreq = this._buildDocFreq();
  }
  _buildDocFreq() {
    /*
        this is used to build the master freq dictionary
        new Set(tokens) is used to remove duplicates and 
        ensure that a word is counted only once even though
        it appears mulitple times in the chunk

        finally it tells use "how many total chunks contain this word atleast once"
    */
    const df = {};
    for (const tokens of this.docTokens) { // each token in this.docTokens
      for (const term of new Set(tokens)) { // for every term in the this.docTokens
        df[term] = (df[term] || 0) + 1;
      }
    }
    return df;
  }

  _idf(term) {
    /* 
        this is basically the value of a word.
        calculates the inverse document frequency.

        if a word has high occurrence, then its score tends to zero
        but a word which is rare, its weight is high

        this ensures that if someone searches "what is bellmanford alg"
        it ignores "is" and focuses on "bellmanford"
    */
    const n = this.docFreq[term] || 0;
    return Math.log((this.N - n + 0.5) / (n + 0.5) + 1);
  }

  _scoreDoc(queryTokens, docIndex) {
    const tokens = this.docTokens[docIndex] || [];
    const doclength = this.docLengths[docIndex] || 0;

    const termFreq = {};

    for (const t of tokens) termFreq[t] = (termFreq[t] || 0) + 1;

    let score = 0;
    for (const term of queryTokens) {
      //checking the term frequency in this specific doc
      const f = termFreq[term] || 0;
      if (f === 0) continue; //i.e if a term isnt present just ignore it

      const numerator = f * (this.k1 + 1);
      const denominator =
        f + this.k1 * (1 - this.b + this.b * (doclength / this.avgDocLength));

      score += this._idf(term) * (numerator / denominator);
    }

    return score;
  }

  search(query, topK = 10) {
    const queryTokens = tokenize(query);
    return this.documents
      .map((doc, i) => ({
        id:
          doc.id ||
          doc.chunkId ||
          doc.metadata?.chunkId ||
          doc.metadata?.chunkID,
        text: doc.text || doc.pageContent,
        score: this._scoreDoc(queryTokens, i),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export { BM25Index, tokenize };
