"""The provider interface every model backend implements.

Keeping this narrow - one method, JSON in, JSON out - is what makes §29's
"the underlying AI provider/model can be replaced later" true in practice.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class ProviderResult:
    text: str
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    raw: dict = field(default_factory=dict)


class LLMProvider(abc.ABC):
    """Generates a single JSON document from a system + user prompt pair."""

    name: str = "unknown"
    model: str = "unknown"

    @abc.abstractmethod
    async def generate_json(
        self,
        *,
        system: str,
        user: str,
        temperature: float,
        max_output_tokens: int,
    ) -> ProviderResult:
        """Return the raw model text, which is expected to be a JSON object."""

    @property
    @abc.abstractmethod
    def is_configured(self) -> bool:
        """Whether an API key is present for this provider."""
