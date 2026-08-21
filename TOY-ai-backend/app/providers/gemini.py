"""Google Gemini, over the Generative Language REST API.

``responseMimeType: application/json`` is what turns §28's "request structured
output rather than arbitrary text" into a provider-level guarantee rather than a
hope pinned on the prompt.
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


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model or settings.gemini_model
        self.base_url = (base_url or settings.gemini_base_url).rstrip("/")

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

        url = f"{self.base_url}/v1beta/models/{self.model}:generateContent"
        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
                "responseMimeType": "application/json",
            },
        }

        try:
            async with httpx.AsyncClient(timeout=settings.timeout_seconds) as client:
                response = await client.post(
                    url,
                    json=payload,
                    headers={
                        "x-goog-api-key": self.api_key,
                        "content-type": "application/json",
                    },
                )
        except httpx.TimeoutException as error:
            raise ProviderTimeout(self.name) from error
        except httpx.HTTPError as error:
            raise AIProviderError(
                "PROVIDER_UNREACHABLE",
                f"Could not reach the Gemini API: {error}",
                status=502,
                retryable=True,
            ) from error

        if response.status_code == 429:
            raise ProviderRateLimited(self.name, _safe_json(response))
        if response.status_code >= 400:
            body = _safe_json(response)
            message = _error_message(body) or response.text[:400]
            raise AIProviderError(
                "PROVIDER_ERROR",
                f"Gemini returned {response.status_code}: {message}",
                status=502,
                # 5xx is worth another attempt; a 4xx is our own bad request.
                retryable=response.status_code >= 500,
                details=body,
            )

        body = response.json()
        candidates = body.get("candidates") or []
        if not candidates:
            # Prompt feedback carries the reason when nothing came back at all.
            reason = (body.get("promptFeedback") or {}).get("blockReason")
            raise AIProviderError(
                "PROVIDER_EMPTY_RESPONSE",
                f"Gemini returned no candidates{f' ({reason})' if reason else ''}.",
                status=502,
                retryable=not reason,
                details=body.get("promptFeedback"),
            )

        first = candidates[0]
        parts = (first.get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts).strip()

        if not text:
            finish = first.get("finishReason")
            raise AIProviderError(
                "PROVIDER_EMPTY_RESPONSE",
                f"Gemini returned an empty answer (finishReason={finish}).",
                status=502,
                retryable=finish not in {"SAFETY", "RECITATION", "PROHIBITED_CONTENT"},
                details=first,
            )

        usage = body.get("usageMetadata") or {}
        return ProviderResult(
            text=text,
            provider=self.name,
            model=self.model,
            prompt_tokens=int(usage.get("promptTokenCount") or 0),
            completion_tokens=int(usage.get("candidatesTokenCount") or 0),
            total_tokens=int(usage.get("totalTokenCount") or 0),
            raw=body,
        )


def _safe_json(response: httpx.Response) -> dict:
    try:
        parsed = response.json()
        return parsed if isinstance(parsed, dict) else {"body": parsed}
    except ValueError:
        return {}


def _error_message(body: dict) -> str | None:
    error = body.get("error")
    if isinstance(error, dict):
        return error.get("message")
    return None
