"""Groq, over its OpenAI-compatible Chat Completions API.

The default provider for the AI features. Same wire format as OpenAI, so only
the endpoint, the key and the model differ - see ``openai_compatible.py`` for
the actual call.
"""

from __future__ import annotations

from ..config import settings
from .openai_compatible import OpenAICompatibleProvider


class GroqProvider(OpenAICompatibleProvider):
    name = "groq"
    label = "Groq"
    # Groq mounts the OpenAI-shaped API under /openai.
    completions_path = "/openai/v1/chat/completions"
    # ``max_tokens`` still works but is deprecated on Groq.
    max_tokens_field = "max_completion_tokens"

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key if api_key is not None else settings.groq_api_key,
            model=model or settings.groq_model,
            base_url=base_url or settings.groq_base_url,
        )
        self.reasoning_effort = settings.groq_reasoning_effort

    def extra_payload(self) -> dict:
        """Cap the thinking budget on the gpt-oss reasoning models.

        Those models spend ``max_completion_tokens`` on reasoning *before* they
        emit anything, so at the default effort a small budget is exhausted
        mid-object and Groq rejects its own truncated output with a 400. Low
        effort is also markedly cheaper: this service asks for copy from facts
        it was handed, not for deduction.

        Blank ``GROQ_REASONING_EFFORT`` for a non-reasoning model, which would
        reject the field outright.
        """
        if not self.reasoning_effort:
            return {}
        return {"reasoning_effort": self.reasoning_effort}
