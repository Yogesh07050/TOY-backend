"""Service-to-service authentication.

Only the Node API is allowed to talk to this service. Node has already
authenticated the user, authorised the shop and enforced the plan limits (§40);
this token is what stops anything else from skipping all of that by calling the
AI service directly.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Header, HTTPException, status

from .config import settings

logger = logging.getLogger("ai.security")

_warned = False


async def require_service_token(x_ai_service_token: str | None = Header(default=None)) -> None:
    global _warned

    if not settings.service_token:
        if settings.env == "production":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "SERVICE_TOKEN_MISSING",
                    "message": "AI_SERVICE_TOKEN must be set in production.",
                },
            )
        if not _warned:
            logger.warning(
                "AI_SERVICE_TOKEN is empty - this service is accepting unauthenticated calls."
            )
            _warned = True
        return

    # Constant-time: the token is a shared secret, so a timing oracle on it is
    # worth closing even on an internal port.
    if not x_ai_service_token or not hmac.compare_digest(
        x_ai_service_token, settings.service_token
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "INVALID_SERVICE_TOKEN", "message": "Invalid AI service token."},
        )
