import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

async function runDay2() {
  console.log("Loading PDF document...");

  //intialize the PDF loader pointing to your file

  const loader = new PDFLoader(
    "/Users/sudha/Downloads/DAA_Study_Guide_Units3_4_5.pdf",
  );
  const docs = await loader.load();

  //now we configure the Text spiltter
  //we use 500 characters per chunk with a 50 char overlay
  //so that sentences crossing boundaries keep their context

  const spiltter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
  });

  console.log("Splitting the doc into semantic chunks...");
  const chunks = await spiltter.splitDocuments(docs);

  console.log(`Created ${chunks.length} total chunks.\n`);

  //we print the first 3 chunks to analyze boundaries
  console.log("---analyzing the first 3 chunks---");
  chunks.slice(0, 10).forEach((chunk, index) => {
    console.log(
      `\n[CHUNK ${index + 1}] (Length: ${chunk.pageContent.length} chars)`,
    );
    console.log("Metadata:", JSON.stringify(chunk.metadata));
    console.log("Content:");
    console.log(chunk.pageContent);
    console.log("-".repeat(40));
  });
}

runDay2().catch(console.error);
