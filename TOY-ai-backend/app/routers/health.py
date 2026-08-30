"""Health and diagnostics.

``/health`` is unauthenticated so a process supervisor can use it. It reports
which provider is selected and whether it has a key, but never the key itself.
``/v1/diagnostics/ping-provider`` does make a real (tiny) model call, so it needs
the service token like every other real endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import settings
from ..providers import get_provider
from ..providers.errors import AIProviderError
from ..security import require_service_token
from ..services import llm

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok" if settings.is_configured else "degraded",
        "service": "toy-ai-backend",
        "env": settings.env,
        "provider": settings.provider_name,
        "model": settings.active_model,
        "providerConfigured": settings.is_configured,
        "keysPresent": {
            name: bool(key) for name, key in settings.provider_keys.items()
        },
    }


@router.post("/v1/diagnostics/ping-provider")
async def ping_provider(
    provider: str | None = None,
    _: None = Depends(require_service_token),
) -> dict:
    """Round-trip the smallest possible request, to prove the key works."""
    engine = get_provider(provider)
    try:
        generation = await llm.generate(
            system='Reply with the JSON object {"ok": true} and nothing else.',
            user="Respond now.",
            provider=engine,
            temperature=0,
            # Not 32: a reasoning model spends this budget thinking before it
            # writes anything, and a truncated object fails the provider's own
            # JSON check - which would read here as a broken key.
            max_output_tokens=256,
        )
    except AIProviderError as error:
        return {
            "ok": False,
            "provider": engine.name,
            "model": engine.model,
            "code": error.code,
            "message": error.message,
        }

    return {
        "ok": True,
        "provider": generation.provider,
        "model": generation.model,
        "response": generation.data,
        "usage": {
            "promptTokens": generation.prompt_tokens,
            "completionTokens": generation.completion_tokens,
            "totalTokens": generation.total_tokens,
        },
    }
