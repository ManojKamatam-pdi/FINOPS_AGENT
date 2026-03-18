"""Unit tests for auth module — no real Okta needed."""
import pytest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException


def test_get_user_email_from_email_claim():
    from auth import get_user_email
    assert get_user_email({"email": "user@pdi.com"}) == "user@pdi.com"


def test_get_user_email_fallback_to_sub():
    from auth import get_user_email
    assert get_user_email({"sub": "00u123"}) == "00u123"


def test_get_user_email_fallback_to_scheduler():
    from auth import get_user_email
    assert get_user_email({}) == "scheduler"


def test_verify_token_raises_on_invalid():
    from auth import verify_okta_token
    with pytest.raises(HTTPException) as exc:
        verify_okta_token("not.a.real.token")
    assert exc.value.status_code == 401
