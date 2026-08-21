"""AI Offer Content Generator models (§15-§22, §34)."""

from __future__ import annotations

from pydantic import Field

from .common import Base, ContentControls, ContentSection, GenerationMeta, OfferFacts

#: Hard caps, applied after generation. §21 asks the backend to validate push
#: length before saving; the same idea is applied to every short-form section.
SECTION_LIMITS: dict[str, int] = {
    "title": 90,
    "shortDescription": 240,
    "detailedDescription": 1200,
    "bannerText": 120,
    "pushNotification": 178,
    "socialCaption": 600,
}

DEFAULT_SECTIONS: list[ContentSection] = [
    "title",
    "shortDescription",
    "detailedDescription",
    "bannerText",
    "pushNotification",
]


class ContentRequest(Base):
    offer: OfferFacts
    sections: list[ContentSection] = Field(default_factory=lambda: list(DEFAULT_SECTIONS))
    controls: ContentControls = Field(default_factory=ContentControls)
    #: Passed by /regenerate: the copy the admin did not like (§34).
    previousVersions: dict[str, list[str]] = Field(default_factory=dict)
    refinement: str | None = Field(default=None, max_length=500)


class ContentResponse(Base):
    """Each section carries its variants in preference order (§19)."""

    sections: dict[str, list[str]] = Field(default_factory=dict)
    suggestedTerms: list[str] = Field(default_factory=list)
    meta: GenerationMeta


class ImproveRequest(Base):
    offer: OfferFacts
    controls: ContentControls = Field(default_factory=ContentControls)
    focus: str | None = Field(default=None, max_length=500)


class ImproveResponse(Base):
    """§14 - what could be better, plus a concrete rewrite to accept or reject."""

    improvements: list[str] = Field(default_factory=list)
    suggestedTitle: str | None = None
    suggestedOfferText: str | None = None
    suggestedShortDescription: str | None = None
    suggestedDescription: str | None = None
    meta: GenerationMeta
