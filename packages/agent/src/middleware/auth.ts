/**
 * Okta JWT middleware for Express.
 * Validates RS256 Bearer tokens using Okta's JWKS endpoint.
 * Attaches decoded claims + raw token to req.user.
 *
 * Supports both org-level (https://domain.okta.com) and custom auth server
 * (https://domain.okta.com/oauth2/default) issuers.
 * JWKS URI: {OKTA_ISSUER}/v1/keys for both variants.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";

// Load env vars before reading process.env constants below
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "../../.env.local") });

// Cache JWKS keyed by issuer URL — invalidates automatically if OKTA_ISSUER changes between restarts
let _jwksIssuer = "";
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  const issuer = (process.env.OKTA_ISSUER ?? "").replace(/\/$/, "");
  if (!_jwks || _jwksIssuer !== issuer) {
    _jwksIssuer = issuer;
    _jwks = createRemoteJWKSet(new URL(`${issuer}/v1/keys`));
  }
  return _jwks;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    email: string;
    sub: string;
    rawToken: string;
    claims: Record<string, unknown>;
  };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Bearer token required" });
    return;
  }
  const token = authHeader.slice(7).trim();

  // Read at call time (not module load time) to ensure dotenv has run
  const issuer = (process.env.OKTA_ISSUER ?? "").replace(/\/$/, "");
  const clientId = process.env.OKTA_CLIENT_ID ?? "";

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer,
      // audience intentionally omitted — Okta org-level access tokens vary in aud claim
      // (may be issuer URL, "api://default", or custom). We validate issuer + cid instead.
    });

    if (payload["cid"] !== clientId) {
      res.status(401).json({ error: "Token client ID mismatch" });
      return;
    }

    req.user = {
      email: String(payload["email"] ?? payload["sub"] ?? ""),
      sub: String(payload["sub"] ?? ""),
      rawToken: token,
      claims: payload as Record<string, unknown>,
    };
    next();
  } catch (err) {
    console.error("[auth] JWT verification failed:", String(err));
    res.status(401).json({ error: `Invalid token: ${String(err)}` });
  }
}
