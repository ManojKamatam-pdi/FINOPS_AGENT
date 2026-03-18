"""Okta JWT validation middleware for FastAPI."""
import os
import httpx
from functools import lru_cache
from fastapi import Header, HTTPException
from jose import jwt, JWTError

OKTA_ISSUER = os.getenv("OKTA_ISSUER", "")
OKTA_CLIENT_ID = os.getenv("OKTA_CLIENT_ID", "")


@lru_cache(maxsize=1)
def _get_jwks() -> dict:
    """Fetch JWKS from Okta. Cached for process lifetime."""
    oidc_url = f"{OKTA_ISSUER}/.well-known/openid-configuration"
    config = httpx.get(oidc_url, timeout=10).json()
    jwks = httpx.get(config["jwks_uri"], timeout=10).json()
    return jwks


def verify_okta_token(token: str) -> dict:
    """Validate Okta JWT. Returns decoded claims or raises HTTPException(401)."""
    try:
        jwks = _get_jwks()
        # Okta access tokens set aud = issuer URL, not the client ID.
        # We verify issuer + aud, then check cid matches our app's client ID.
        claims = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
            audience=OKTA_ISSUER,
            issuer=OKTA_ISSUER,
        )
        if claims.get("cid") != OKTA_CLIENT_ID:
            raise HTTPException(status_code=401, detail="Token client ID mismatch")
        return claims
    except JWTError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Auth error: {e}")


async def get_current_user(authorization: str = Header(...)) -> dict:
    """FastAPI dependency — extracts and validates Bearer token."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = authorization.removeprefix("Bearer ").strip()
    claims = verify_okta_token(token)
    claims["_raw_token"] = token  # store for downstream use
    return claims


def get_user_email(claims: dict) -> str:
    """Extract email from JWT claims, fallback to sub or 'scheduler'."""
    return claims.get("email") or claims.get("sub") or "scheduler"
