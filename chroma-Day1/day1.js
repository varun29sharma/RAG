import { ChromaClient } from "chromadb";
//import { DefaultEmbeddingFunction } from "chromadb-default-embed";

async function runDay1() {
  //initializing the client - 8080
  const client = new ChromaClient();
  //use the built-in embedding function
  //   const embedder = new DefaultEmbeddingFunction();

  //creat or get a clean collection
  console.log("Creating collection...");
  try {
    await client.deleteCollection({ name: "Day1_sentences" });
  } catch (e) {
    console.error;
    //this means no collection exists
  }

  const collection = await client.createCollection({
    name: "Day1_sentences",
  });

  //Defining 5-6 short mixed topic sentences

  const documents = [
    "Cricket is a bat-and-ball game played between two teams of eleven players.",
    "The chef prepared a delicious three-course meal for the guests.",
    "Electric cars use a battery instead of an internal combustion engine.",
    "Baking a cake requires precise measurements of flour, sugar, and eggs.",
    "The formula 1 race car reached top speeds on the straightaway.",
  ];

  //chroma expects IDs for every doc
  const ids = ["id_cricket", "id_chef", "id_ev", "id_baking", "id_f1"];

  console.log("Adding docs and generating embeddings");
  await collection.add({
    ids: ids,
    documents: documents,
  });

  //now we start querying with keyword groupings

  console.log("Test 1: Keyword-adjacent Semantic Query ---");
  const query1 = "Whon won the cricket match?";
  const res1 = await collection.query({
    queryTexts: [query1],
    nResults: 2, // -> get the 2 closest matches
  });

  console.log(`Query: "${query1}"`);
  console.log("Top matches:", res1.documents[0]);

  //now we test Zero Keyword overlap ---
  console.log("Test 2: Zero keyword overlap Query ---");

  const query2 = "who cooked food?";

  const res2 = await collection.query({
    queryTexts: [query2],
    nResults: 1,
  });

  console.log(`Query: "${query2}"`);
  console.log("Top match:", res2.documents[0]);
}

runDay1().catch(console.error);
