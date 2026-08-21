"""Provider selection.

TOY.md asks for "a boolean to switch between openai and google gemini - either
one should work". That boolean is ``USE_GEMINI``; nothing above this module
knows which one it got.
"""

from __future__ import annotations

from ..config import settings
from .base import LLMProvider, ProviderResult
from .errors import (
    AIProviderError,
    InvalidModelOutput,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
)
from .gemini import GeminiProvider
from .openai import OpenAIProvider


def get_provider(name: str | None = None) -> LLMProvider:
    """Return the configured provider, or a named one for a diagnostic call."""
    resolved = (name or settings.provider_name).lower()
    if resolved == "openai":
        return OpenAIProvider()
    if resolved == "gemini":
        return GeminiProvider()
    raise AIProviderError(
        "UNKNOWN_PROVIDER",
        f"'{resolved}' is not a supported provider. Use 'gemini' or 'openai'.",
        status=400,
    )


__all__ = [
    "AIProviderError",
    "GeminiProvider",
    "InvalidModelOutput",
    "LLMProvider",
    "OpenAIProvider",
    "ProviderNotConfigured",
    "ProviderRateLimited",
    "ProviderResult",
    "ProviderTimeout",
    "get_provider",
]
