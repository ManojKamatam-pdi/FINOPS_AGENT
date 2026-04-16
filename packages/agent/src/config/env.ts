/**
 * Loads packages/agent/.env.local before any other module runs.
 * Must be the first import in server.ts — ES module imports are hoisted,
 * so dotenv cannot be called inline in server.ts before other imports execute.
 *
 * Single source of truth for all backend env vars.
 * In deployment, all vars come from secrets manager — no .env.local file needed.
 */
import dotenv from "dotenv";
import { join } from "path";

// process.cwd() = packages/agent/ when started via start-agent.ps1
dotenv.config({ path: join(process.cwd(), ".env.local") });
