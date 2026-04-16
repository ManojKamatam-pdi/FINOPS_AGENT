/**
 * FinOps Agent Server — single TypeScript backend.
 * Replaces Python FastAPI entirely.
 *
 * Routes:
 *   GET  /health          — no auth, liveness check
 *   POST /api/trigger     — Okta auth, start analysis run
 *   GET  /api/status      — Okta auth, poll run progress
 *   GET  /api/results     — Okta auth, fetch completed results
 *   POST /run             — internal agent trigger (no auth, localhost only)
 *
 * Startup: creates DynamoDB tables if they don't exist, then listens.
 * Scheduler: no-op locally; EventBridge + Lambda handles nightly runs in AWS.
 */
// MUST be first — loads .env.local before any other module executes.
// ES module imports are hoisted, so dotenv cannot run inline before other imports.
import "./config/env.js";

// Each concurrent agent query() adds a process exit listener.
// With up to 10 batch agents + 2 orgs running in parallel, raise the limit.
process.setMaxListeners(100);

import express from "express";
import cors from "cors";
import { createTables } from "./db/setup.js";
import { requireAuth } from "./middleware/auth.js";
import { apiRouter } from "./routes/api.js";
import { sloApiRouter } from "./routes/slo-api.js";
import { runOrchestrator } from "./agents/orchestrator.js";

const app = express();

app.use(cors({
  origin: ["http://localhost:3000", /\.cloudfront\.net$/],
  credentials: true,
}));
app.use(express.json());

const PORT = parseInt(process.env.AGENT_SERVER_PORT ?? "8005", 10);

// Health — no auth required
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "finops-agent" });
});

// REST API — Okta auth required
// SLO router must be mounted BEFORE the general API router to avoid /api catching /api/slo/* first
app.use("/api/slo", requireAuth, sloApiRouter);
app.use("/api", requireAuth, apiRouter);

// Internal agent trigger — kept for direct testing / backward compat
app.post("/run", async (req, res) => {
  const { run_id, okta_token } = req.body as { run_id?: string; okta_token?: string };
  if (!run_id) {
    res.status(400).json({ error: "run_id is required" });
    return;
  }
  res.status(202).json({ run_id, status: "started" });
  runOrchestrator(run_id, okta_token ?? "").catch((err: unknown) => {
    console.error(`[agent-server] Orchestrator failed for run ${run_id}:`, err);
  });
});

// Startup: create tables then listen
createTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[agent-server] FinOps Agent Server running on port ${PORT}`);
      console.log(`[agent-server] API: http://localhost:${PORT}/api`);
    });
  })
  .catch((err) => {
    console.error("[agent-server] Failed to create DynamoDB tables:", err);
    process.exit(1);
  });
