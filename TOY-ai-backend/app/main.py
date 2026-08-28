"""FastAPI application for the Offers App AI service.

Isolated on purpose (§29): it holds the provider keys and the prompts, and
nothing else. No database, no user records, no authorisation decisions - those
stay in the Node API, which is the only caller.

    uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .providers.errors import AIProviderError
from .routers import assistant, content, health

logging.basicConfig(
    level=logging.INFO if settings.env != "development" else logging.DEBUG,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
logger = logging.getLogger("ai")

app = FastAPI(
    title="Offers App - AI service",
    version="1.0.0",
    description=(
        "AI Offer Assistant and AI Offer Content Generation. Called only by the "
        "Offers App Node API."
    ),
    docs_url="/docs" if settings.env != "production" else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "x-ai-service-token"],
)

app.include_router(health.router)
app.include_router(assistant.router)
app.include_router(content.router)


@app.exception_handler(AIProviderError)
async def provider_error_handler(_: Request, error: AIProviderError) -> JSONResponse:
    """Answer in one shape so Node can map codes to the §36 wording."""
    logger.warning("%s: %s", error.code, error.message)
    return JSONResponse(
        status_code=error.status,
        content={
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            }
        },
    )


@app.on_event("startup")
async def announce() -> None:
    logger.info(
        "AI service ready | provider=%s model=%s configured=%s",
        settings.provider_name,
        settings.active_model,
        settings.is_configured,
    )
    if not settings.is_configured:
        logger.warning(
            "No API key for %s. Set %s in the repository-root .env or in "
            "TOY-ai-backend/.env.",
            settings.provider_name,
            settings.api_key_env_var,
        )
