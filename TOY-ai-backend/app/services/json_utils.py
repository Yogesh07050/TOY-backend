"""Turning model text into a dict, defensively.

Both providers are asked for JSON mode, but a model can still wrap the object in
a code fence or add a sentence around it. §28 makes the structured document the
contract, so parsing has to be forgiving of the packaging while staying strict
about the content.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..providers.errors import InvalidModelOutput

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def _strip_fences(text: str) -> str:
    return _FENCE.sub("", text.strip()).strip()


def _first_json_object(text: str) -> str | None:
    """Return the first balanced ``{...}`` span, ignoring braces inside strings."""
    start = text.find("{")
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False

    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse ``text`` into a dict, or raise ``InvalidModelOutput``."""
    candidate = _strip_fences(text)

    for attempt in (candidate, _first_json_object(candidate) or ""):
        if not attempt:
            continue
        try:
            parsed = json.loads(attempt)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list):
            # A bare array is a plausible slip; wrap it rather than fail.
            return {"items": parsed}

    raise InvalidModelOutput(
        "The model did not return a JSON object.",
        details={"preview": text[:400]},
    )


def as_str_list(value: Any, limit: int | None = None) -> list[str]:
    """Coerce a model field into a clean list of non-empty strings."""
    if value is None:
        return []
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = [value]

    result: list[str] = []
    for item in items:
        if isinstance(item, dict):
            item = item.get("text") or item.get("value") or ""
        text = str(item).strip()
        if text:
            result.append(text)
    return result[:limit] if limit else result
