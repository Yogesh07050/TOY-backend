"""Provider selection.

TOY.md asks for "a boolean to switch between openai and google gemini - either
one should work". That boolean is ``USE_GROQ`` - the AI features run on Groq
now, with OpenAI as the other side of the switch. Gemini is still here and
still works, but only when named explicitly through ``AI_PROVIDER`` (or the
``ping-provider`` diagnostic). Nothing above this module knows which one it got.
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
from .groq import GroqProvider
from .openai import OpenAIProvider

PROVIDERS: dict[str, type[LLMProvider]] = {
    "groq": GroqProvider,
    "openai": OpenAIProvider,
    "gemini": GeminiProvider,
}


def get_provider(name: str | None = None) -> LLMProvider:
    """Return the configured provider, or a named one for a diagnostic call."""
    resolved = (name or settings.provider_name).lower()
    provider = PROVIDERS.get(resolved)
    if provider is None:
        supported = ", ".join(f"'{key}'" for key in PROVIDERS)
        raise AIProviderError(
            "UNKNOWN_PROVIDER",
            f"'{resolved}' is not a supported provider. Use one of {supported}.",
            status=400,
        )
    return provider()


__all__ = [
    "AIProviderError",
    "GeminiProvider",
    "GroqProvider",
    "InvalidModelOutput",
    "LLMProvider",
    "OpenAIProvider",
    "PROVIDERS",
    "ProviderNotConfigured",
    "ProviderRateLimited",
    "ProviderResult",
    "ProviderTimeout",
    "get_provider",
]
