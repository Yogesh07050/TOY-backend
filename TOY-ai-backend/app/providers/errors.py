"""Provider failures, normalised.

The codes here are the whole contract with the Node API: Node maps them to the
merchant-facing wording in §36 and never shows the underlying message (§37).
"""

from __future__ import annotations


class AIProviderError(Exception):
    """A call to the model provider could not be completed."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 502,
        retryable: bool = False,
        details: object | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.retryable = retryable
        self.details = details


class ProviderNotConfigured(AIProviderError):
    def __init__(self, provider: str) -> None:
        super().__init__(
            "PROVIDER_NOT_CONFIGURED",
            f"No API key is configured for the selected provider ({provider}).",
            status=503,
        )


class ProviderTimeout(AIProviderError):
    def __init__(self, provider: str) -> None:
        super().__init__(
            "PROVIDER_TIMEOUT",
            f"The {provider} API did not respond in time.",
            status=504,
            retryable=True,
        )


class ProviderRateLimited(AIProviderError):
    def __init__(self, provider: str, details: object | None = None) -> None:
        super().__init__(
            "PROVIDER_RATE_LIMITED",
            f"The {provider} API rate limit was reached.",
            status=429,
            retryable=True,
            details=details,
        )


class InvalidModelOutput(AIProviderError):
    """The model answered, but not with usable structured data (§28)."""

    def __init__(self, message: str, details: object | None = None) -> None:
        super().__init__("INVALID_MODEL_OUTPUT", message, status=502, details=details)
