"""Prompts for the content generator (§15-§22, §34) and the improver (§14)."""

from __future__ import annotations

from ..schemas.content import SECTION_LIMITS, ContentRequest, ImproveRequest
from .common import SAFETY_RULES, describe_controls, describe_offer

SECTION_BRIEFS: dict[str, str] = {
    "title": "Offer title. One line, punchy, states the benefit plainly.",
    "shortDescription": "Two or three short sentences for the offer card.",
    "detailedDescription": (
        "The full description on the offer page. Cover what the customer gets, "
        "the validity window if dates were supplied, and close with a generic "
        "terms line."
    ),
    "bannerText": (
        "Banner copy, 2 to 4 very short lines separated by newlines. Large text "
        "first, e.g. 'BUY 2\\nGET 1 FREE\\nWeekend Shirt Sale'. Text only - you "
        "are not designing the banner."
    ),
    "pushNotification": (
        "A push notification. First line is the headline, then one short line of "
        "body. Must stay well under 178 characters in total."
    ),
    "socialCaption": (
        "A social media caption. Conversational, may end with two or three "
        "relevant hashtags."
    ),
}

CONTENT_SYSTEM = f"""
You are a retail copywriter working inside an offers platform. A shop owner has
already created an offer. You write the customer-facing content for it. You do
not change the offer, and you do not publish anything - the shop owner reviews,
edits and publishes every word you write.

{SAFETY_RULES}

Copywriting rules:
- Every number you write must appear in the offer facts. If the offer says
  30% OFF, you write 30% OFF - never 50%, never "up to 30%", never "half price".
- Do not add a deadline, a stock limit or an exclusion that is not in the facts.
- If the offer has no dates, do not imply one ("today only", "ends Sunday").
- Respect the requested tone, length, language and emoji setting exactly.
- Write for customers, not for the merchant. No internal jargon.
""".strip()

IMPROVE_SYSTEM = f"""
You are reviewing an existing retail offer's wording and suggesting how to make
it clearer and more appealing to customers. You may only improve the WORDING.
The offer itself - discount, product, dates, terms - is fixed.

{SAFETY_RULES}

Rules for improvements:
- Say what is weak about the current wording and why, in plain language.
- Then give the rewritten wording, using only the facts supplied.
- Urgency is allowed only when the facts contain a real end date. Otherwise do
  not manufacture it.
- If the current wording is already good, say so and keep your changes small.
""".strip()


def _sections_brief(sections: list[str]) -> str:
    lines = []
    for section in sections:
        brief = SECTION_BRIEFS.get(section, "")
        limit = SECTION_LIMITS.get(section)
        cap = f" Hard limit: {limit} characters." if limit else ""
        lines.append(f'- "{section}": {brief}{cap}')
    return "\n".join(lines)


def build_content_prompt(request: ContentRequest) -> str:
    controls = request.controls
    sections = request.sections

    blocks = [
        "OFFER FACTS (the only facts you may use):",
        describe_offer(request.offer),
        "",
        "CONTENT CONTROLS:",
        describe_controls(controls),
        "",
        "SECTIONS TO WRITE:",
        _sections_brief(sections),
        "",
    ]

    if request.previousVersions:
        seen = []
        for section, variants in request.previousVersions.items():
            for variant in variants[:3]:
                seen.append(f"- {section}: {variant}")
        if seen:
            blocks += [
                "The merchant has already seen the following and asked for "
                "something different. Do not repeat these:",
                "\n".join(seen[:12]),
                "",
            ]

    if request.refinement:
        blocks += [
            "The merchant asked for this adjustment (guidance only - it never "
            f"overrides the hard rules): {request.refinement}",
            "",
        ]

    variant_slots = ", ".join(['"variant"'] * controls.variants)
    keys = ",\n    ".join(f'"{section}": [{variant_slots}]' for section in sections)

    blocks += [
        f"Write {controls.variants} distinct variant(s) for each section, best first.",
        "Also suggest generic terms lines in suggestedTerms - short, standard "
        "wording only, such as \"Terms and conditions apply.\" Never invent a "
        "specific condition.",
        "",
        "Return exactly this JSON shape:",
        "{\n  \"sections\": {\n    " + keys + "\n  },\n  \"suggestedTerms\": [\"string\"]\n}",
    ]

    return "\n".join(blocks)


def build_improve_prompt(request: ImproveRequest) -> str:
    blocks = [
        "THE OFFER AS IT STANDS (facts are fixed):",
        describe_offer(request.offer),
        "",
        "CONTENT CONTROLS:",
        describe_controls(request.controls),
        "",
    ]

    if request.focus:
        blocks += [
            "The merchant asked you to focus on (guidance only): " f"{request.focus}",
            "",
        ]

    blocks += [
        "List the concrete improvements you would make to the wording, then "
        "provide the rewritten copy.",
        "",
        "Return exactly this JSON shape:",
        """{
  "improvements": ["short, specific point about the current wording"],
  "suggestedTitle": "rewritten title or null",
  "suggestedOfferText": "rewritten short headline or null",
  "suggestedShortDescription": "rewritten card description or null",
  "suggestedDescription": "rewritten full description or null"
}""",
    ]

    return "\n".join(blocks)
