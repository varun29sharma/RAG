# Roadmap — Campus Copilot, from solid core to shipped product

Ordered by priority. ✅ = shipped. Phases 2–3 make the project **defensible** (numbers, reliability); Phases 4–5 make it a **product with users**.

---

## Phase 0 — Code health ✅ SHIPPED

| # | Task | Status |
|---|---|---|
| P0-1 | **Single shared retrieval core** (`chroma-Day1/lib/retrieval-core.js`): ID hashing, record normalization, rerank (with timeout + graceful degradation), RRF candidate-pool selection, `hybridRetrieve` entrypoint — all in one module. `server.js` is now a thin HTTP shell; `retrieval-pipeline.js` is a compat re-export; `tools.js` uses the same core. | ✅ |
| P0-2 | **Single service initialization** in `server.js` (`startServer()` is the only init path). | ✅ |
| P0-3 | **Generic ingestion CLI**: `node ingest.js --pdf <path> --collection <name> [--name] [--replace] [--migrate-legacy]`, with validation and clear errors. | ✅ |
| P0-4 | **Renamed** `retreive.js` → `retrieve.js`. | ✅ |
| P0-5 | **Outbound hardening**: Cohere fetch has an `AbortController` timeout (default 8s, env-tunable). | ✅ |
| — | **Bonus: offline test suite** (`chroma-Day1/test/`) via dependency injection — 7 tests, no services needed. | ✅ |
| — | **Bonus: document registry** (`lib/chunk-store.js`) + multi-collection vector fan-out (`lib/vector-store.js`) — the foundation for multi-document retrieval. | ✅ |

---

## Phase 1 — Reliability & operations

| # | Task | Why | Effort |
|---|---|---|---|
| P1-1 | **`/health` deep checks**: verify Ollama responds and the Chroma ping succeeds, not just report state. | A health endpoint that doesn't check dependencies is decoration. | S |
| P1-2 | **Graceful shutdown** (`SIGTERM` → close server, dispose clients). | Clean container restarts. | S |
| P1-3 | **Structured logging (pino)**: request IDs + per-stage timings (vector/BM25/rerank/LLM ms) as one JSON line per request. The API already returns `retrievalMs`/`generationMs` — log them properly too. | Turns debugging into queryable data; *proves* where latency lives. | M |
| P1-4 | **Security pass**: `helmet`, CORS locked to the frontend origin, `express-rate-limit` on `/api/chat`, zod validation of request bodies. | Table stakes beyond localhost. | S |
| P1-5 | **Centralized config**: the env knobs now exist (`OLLAMA_BASE_URL`, `CHROMA_HOST/PORT`, `RAG_*`) but are read in several places — consolidate into `lib/config.js` with startup validation. | One place documents every knob. | S |

---

## Phase 2 — Evaluation & CI (the strongest interview artifact)

| # | Task | Why | Effort |
|---|---|---|---|
| P2-1 | **Unit tests** — ✅ seed shipped: offline suite covers BM25, `hybridRetrieve`, RRF, registry. Grow it: normalization edge cases, `_idf` behavior, pool-selection fallback branch. | Pure functions, free coverage. | S (remainder) |
| P2-2 | **API integration test** for `/api/chat` with Ollama/Chroma/Cohere mocked: 400/503/200 shapes, sources array, timings. | Proves the HTTP layer without models running. | M |
| P2-3 | **Golden-QA eval harness** (`eval/golden-qa.json`: ~30 real questions + expected source chunks). Script runs the pipeline offline and reports **recall@3, MRR**, with ablations: **rerank on/off**, **hybrid vs dense-only vs BM25-only**, per-collection breakdowns. | "Hybrid retrieval improved recall@3 from 0.61 → 0.84; the cross-encoder added 9% MRR" is the single most impressive sentence you can say about a RAG project. Also makes chunk size, `k1/b`, `k=60` tunable with feedback instead of vibes. | L |
| P2-4 | **CI** (GitHub Actions): `npm test` on every push; nightly eval-harness run with results committed to the README badge/section. | Green badge + quality trendline = professionalism. | M |

---

## Phase 3 — Product features

| # | Task | Why | Effort |
|---|---|---|---|
| P3-1 | **SSE streaming** — token-by-token answers. | Perceived latency seconds → instant; biggest demo-day upgrade. | M |
| P3-2 | **Conversation memory on `/api/chat`** — LangGraph checkpointer or a session window with follow-up query rewriting. | "And its space complexity?" currently loses all context. | M |
| P3-3 | **Citations in the UI** — the API already returns `sources[]`; render them as clickable chips (document + page). Also carry page metadata through the vector path end-to-end. | Verifiability is the trust feature of RAG. | M |
| P3-4 | **Frontend polish**: markdown rendering, styles out of inline attributes into `App.css`, per-answer retrieval-stage timing badges. | First thing a recruiter sees. | M |
| P3-5 | **Query preprocessing**: condense follow-ups into standalone queries; split multi-part questions. | Where real-world RAG quality usually breaks. | M |

---

## Phase 4 — Deployment & scale

| # | Task | Why | Effort |
|---|---|---|---|
| P4-1 | **docker-compose**: Chroma + Ollama + server + frontend, one command. | `docker compose up` = demo on any laptop in minutes. | M |
| P4-2 | **Semantic cache** (embedding → answer above a similarity threshold). | LLM calls are the latency bottleneck; classic production pattern. | S |
| P4-3 | **Provider abstraction**: embeddings/LLM/vector-store swappable via env (OpenAI, Qdrant/Pinecone, GPT-4o). | Shows you understand the *interfaces*, not just this stack. | M |
| P4-4 | **Ingestion improvements**: folder-of-PDFs ingestion, DOCX/HTML loaders, metadata filtering at query time. | From CLI to platform. | M |

---

## Phase 5 — The Campus Pilot (the purpose, realized)

| # | Task | Why | Effort |
|---|---|---|---|
| P5-1 | **Collect 10–20 real campus documents**: placement policy, scholarship circulars, exam schedules, hostel rules, syllabi, club docs. | Real, messy, multi-source data is what stresses a RAG system honestly. | S |
| P5-2 | **Organize into collections** (`campus-policies`, `academics`, `events`) via the ingest CLI. | Exercises the multi-document design end-to-end. | S |
| P5-3 | **Pilot with classmates**; log every question the copilot fails. | Failure logs = the highest-value backlog a RAG project can have. | S |
| P5-4 | **Fix the top failures, re-run the eval harness, publish before/after numbers.** | This loop — users → failures → measurement → fix — *is* production engineering. No other student project will have it. | M |
| P5-5 | **Write it up**: a short README section ("Pilot results") with usage stats, failure classes, and eval deltas. | The story that closes the interview. | S |

---

## Suggested order for interview prep

1. **P2-3 eval harness** — turn opinions into numbers first; every later change becomes measurable.
2. **P1-3 + P1-4** — structured logs + security pass = "production-ready" becomes defensible.
3. **P3-1 + P3-3** — streaming + citations make the live demo feel like a product.
4. **P5 campus pilot** — real users, real failures, real numbers; the differentiator nobody else will have.

Every remaining item maps to a system-design talking point: graceful degradation (already demoable — boot without Chroma and watch BM25-only mode), observability (P1-3), evaluation-driven development (P2-3), caching (P4-2), provider abstraction (P4-3), and user-driven iteration (P5).
