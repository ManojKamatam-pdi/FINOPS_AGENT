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

// Always create a fresh JWKS fetcher — no singleton cache.
// jose internally caches the keyset per instance; by creating a new instance
// on each call we guarantee a fresh fetch when Okta rotates keys.
function makeJwks(issuer: string) {
  return createRemoteJWKSet(new URL(`${issuer}/v1/keys`), {
    cacheMaxAge: 5 * 60 * 1000, // cache within this instance for 5 min
    cooldownDuration: 0,
  });
}

// Module-level cache: invalidated whenever issuer changes or on JWKSNoMatchingKey
let _jwksIssuer = "";
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(issuer: string) {
  if (!_jwks || _jwksIssuer !== issuer) {
    _jwksIssuer = issuer;
    _jwks = makeJwks(issuer);
  }
  return _jwks;
}

function resetJwks(issuer: string) {
  _jwksIssuer = issuer;
  _jwks = makeJwks(issuer);
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

  const issuer = (process.env.OKTA_ISSUER ?? "").replace(/\/$/, "");
  const clientId = process.env.OKTA_CLIENT_ID ?? "";

  const verify = async (jwks: ReturnType<typeof createRemoteJWKSet>) =>
    jwtVerify(token, jwks, { issuer });

  try {
    let payload: Record<string, unknown>;

    try {
      const result = await verify(getJwks(issuer));
      payload = result.payload as Record<string, unknown>;
    } catch (firstErr) {
      // On JWKSNoMatchingKey, Okta has rotated keys — force a fresh fetch and retry once
      if (String(firstErr).includes("JWKSNoMatchingKey")) {
        console.warn("[auth] JWKSNoMatchingKey — refreshing JWKS and retrying");
        const result = await verify(resetJwks(issuer));
        payload = result.payload as Record<string, unknown>;
      } else {
        throw firstErr;
      }
    }

    if (payload["cid"] !== clientId) {
      res.status(401).json({ error: "Token client ID mismatch" });
      return;
    }

    req.user = {
      email: String(payload["email"] ?? payload["sub"] ?? ""),
      sub: String(payload["sub"] ?? ""),
      rawToken: token,
      claims: payload,
    };
    next();
  } catch (err) {
    console.error("[auth] JWT verification failed:", String(err));
    res.status(401).json({ error: `Invalid token: ${String(err)}` });
  }
}
