"""Chat Completions over the OpenAI wire format.

Groq and OpenAI speak the same request/response shape, so the HTTP handling,
the error normalisation and the usage accounting live here once. A concrete
provider is then a name, a label for error messages, and where its settings
come from.

``response_format: {"type": "json_object"}`` is what turns §28's "request
structured output rather than arbitrary text" into a provider-level guarantee
rather than a hope pinned on the prompt.
"""

from __future__ import annotations

import httpx

from ..config import settings
from .base import LLMProvider, ProviderResult
from .errors import (
    AIProviderError,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
)


class OpenAICompatibleProvider(LLMProvider):
    name = "openai-compatible"

    #: How the provider is named in an error message a developer reads.
    label = "OpenAI-compatible"

    #: Appended to the base URL. Groq serves the same API under /openai.
    completions_path = "/v1/chat/completions"

    #: Groq deprecated ``max_tokens`` in favour of ``max_completion_tokens``.
    max_tokens_field = "max_tokens"

    def __init__(self, api_key: str, model: str, base_url: str) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

    def extra_payload(self) -> dict:
        """Provider-specific request fields merged into the body."""
        return {}

    async def generate_json(
        self,
        *,
        system: str,
        user: str,
        temperature: float,
        max_output_tokens: int,
    ) -> ProviderResult:
        if not self.is_configured:
            raise ProviderNotConfigured(self.name)

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            self.max_tokens_field: max_output_tokens,
            "response_format": {"type": "json_object"},
            **self.extra_payload(),
        }

        try:
            async with httpx.AsyncClient(timeout=settings.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}{self.completions_path}",
                    json=payload,
                    headers={
                        "authorization": f"Bearer {self.api_key}",
                        "content-type": "application/json",
                    },
                )
        except httpx.TimeoutException as error:
            raise ProviderTimeout(self.name) from error
        except httpx.HTTPError as error:
            raise AIProviderError(
                "PROVIDER_UNREACHABLE",
                f"Could not reach the {self.label} API: {error}",
                status=502,
                retryable=True,
            ) from error

        if response.status_code == 429:
            raise ProviderRateLimited(self.name, _safe_json(response))
        if response.status_code >= 400:
            body = _safe_json(response)
            message = (body.get("error") or {}).get("message") or response.text[:400]
            raise AIProviderError(
                "PROVIDER_ERROR",
                f"{self.label} returned {response.status_code}: {message}",
                status=502,
                # 5xx is worth another attempt; a 4xx is our own bad request.
                retryable=response.status_code >= 500,
                details=body,
            )

        body = response.json()
        choices = body.get("choices") or []
        text = (choices[0].get("message", {}).get("content") or "").strip() if choices else ""

        if not text:
            finish = choices[0].get("finish_reason") if choices else None
            raise AIProviderError(
                "PROVIDER_EMPTY_RESPONSE",
                f"{self.label} returned an empty answer"
                + (f" (finish_reason={finish})." if finish else "."),
                status=502,
                retryable=finish not in {"content_filter"},
                details=body,
            )

        usage = body.get("usage") or {}
        return ProviderResult(
            text=text,
            provider=self.name,
            model=self.model,
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            total_tokens=int(usage.get("total_tokens") or 0),
            raw=body,
        )


def _safe_json(response: httpx.Response) -> dict:
    try:
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {"body": parsed}
    except ValueError:
        return {}
