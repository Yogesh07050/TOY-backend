"""OpenAI, over the Chat Completions REST API.

Present so the ``USE_GEMINI`` switch has something to switch to; the calling code
cannot tell the two apart.
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


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.openai_api_key
        self.model = model or settings.openai_model
        self.base_url = (base_url or settings.openai_base_url).rstrip("/")

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)

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
            "max_tokens": max_output_tokens,
            "response_format": {"type": "json_object"},
        }

        try:
            async with httpx.AsyncClient(timeout=settings.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/v1/chat/completions",
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
                f"Could not reach the OpenAI API: {error}",
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
                f"OpenAI returned {response.status_code}: {message}",
                status=502,
                retryable=response.status_code >= 500,
                details=body,
            )

        body = response.json()
        choices = body.get("choices") or []
        text = (choices[0].get("message", {}).get("content") or "").strip() if choices else ""

        if not text:
            raise AIProviderError(
                "PROVIDER_EMPTY_RESPONSE",
                "OpenAI returned an empty answer.",
                status=502,
                retryable=True,
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
