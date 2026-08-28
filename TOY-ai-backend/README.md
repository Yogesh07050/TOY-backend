# TOY-ai-backend — AI service (Python / FastAPI)

The AI layer for the Offers App: the **AI Offer Assistant** and the **AI Offer
Content Generator** described in `TOY.md`.

It is deliberately the *only* place that knows about model providers, prompts
and API keys. It has no database, no user table and no authorisation logic — the
Node API (`TOY-backend`) authenticates the merchant, decides what data they are
allowed to see, enforces the subscription limits, and only then calls this
service.

```
Angular (TOY-frontend)
      ↓  /api/ai/*
Node API (TOY-backend)      auth · plan limits · merchant data · usage log · validation
      ↓  HTTP + x-ai-service-token
Python AI service (this)    provider switch · prompts · structured output · fact guard
      ↓
Groq (default)  |  OpenAI
```

## Running it

Normally you do not: `./start.sh` at the repository root starts this service
along with the API and the web app. To run it on its own:

```bash
cd TOY-backend/TOY-ai-backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env          # optional: the repo-root .env already has the key
uvicorn app.main:app --reload --port 8000
```

Interactive docs while running in development: <http://localhost:8000/docs>

### Configuration

Environment is read from **every `.env` between the repository root and this
folder**, loaded outermost first so the closest one wins:

```
OTY/.env  →  TOY-backend/.env  →  TOY-backend/TOY-ai-backend/.env  →  real env
```

Two things fall out of that: `GROQ_API_KEY` is picked up from the repo-root
`.env` where the project already keeps it, and `AI_SERVICE_TOKEN` set for the
Node API is shared with this service automatically, so the two cannot drift.

| Variable | Default | Notes |
| --- | --- | --- |
| `USE_GROQ` | `true` | **The provider switch.** `true` → Groq, `false` → OpenAI. |
| `AI_PROVIDER` | — | Optional override. Names a provider outright (`groq`, `openai`, or the legacy `gemini`) and ignores `USE_GROQ`. |
| `GROQ_API_KEY` | — | Read from the root `.env` if not set here. Get one at <https://console.groq.com/keys>. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Free-tier friendly and honours JSON `response_format`. `llama-3.1-8b-instant` is cheaper and faster. |
| `OPENAI_API_KEY` | — | Only needed when `USE_GROQ=false`. |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
| `AI_SERVICE_TOKEN` | — | Shared secret with the Node API. Required in production; a warning-only no-op in development. |
| `AI_TEMPERATURE` | `0.7` | Corrections always re-run at 0.2. |
| `AI_MAX_RETRIES` | `2` | Applies to transient provider errors and unparseable answers. |

Check what is live:

```bash
curl localhost:8000/health
curl -X POST localhost:8000/v1/diagnostics/ping-provider \
     -H "x-ai-service-token: $AI_SERVICE_TOKEN"
```

## Endpoints

All of them require `x-ai-service-token` and take/return JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness, selected provider, whether a key is present. |
| `POST` | `/v1/assistant/recommend` | "What offer should I create?" → structured recommendations (§4–§8, §28). |
| `POST` | `/v1/assistant/regenerate` | Same, with `previousTitles` so the ideas differ (§7). |
| `POST` | `/v1/content/generate` | Title, descriptions, banner, push, social caption (§15–§22). |
| `POST` | `/v1/content/regenerate` | Same, with `previousVersions` + `refinement` (§34). |
| `POST` | `/v1/offer/improve` | "Improve this offer" — critique plus a rewrite (§14). |
| `POST` | `/v1/diagnostics/ping-provider` | Smallest possible real model call. |

## How the safety requirements are met

**§23 — the AI must never invent facts.** `services/validation.py` holds a fact
guard. It builds an allow-list of every number the merchant actually entered
(discount, prices, quantities, minimum purchase, plus any number already in
their own title or terms, plus the saving their prices imply) and then scans
every generated string for percentages, money, buy-X-get-Y pairs and dates. A
claim that cannot be traced back to the offer is a violation.

Violations are fed back to the model once, at a low temperature, as an explicit
correction. Copy that still fails is **dropped, not shown** — a missing variant
is recoverable, a published "50% OFF" on a 30% offer is not. If nothing survives
the service returns an error and the merchant writes the offer by hand (§36).

**§11, §38 — observed data must stay distinguishable from advice, and gaps must
not be filled in.** Every reason the assistant gives is tagged `observed` or
`general`. `ContextGuard` re-checks the tags server-side: a reason tagged
`observed` is downgraded when no history was supplied, and dropped outright if
it quotes a statistic that was not in the data. `insufficientData` is forced on
whenever there was no history to reason from, whatever the model claimed.

**§3, §12, §13 — premium insights are plan-gated.** The Node API sets
`allowHistoricalInsights` / `allowLocationInsights` / `allowTimingInsights` from
the shop's plan. Sections the plan does not include are never put in the prompt,
*and* the corresponding insight fields are blanked on the way out, so a prompt
injection cannot talk its way into a premium answer.

**§40 — keys never reach the browser, and only the Node API may call this.** The
providers are reached over server-side HTTP with the key in a header, and
`security.py` requires the shared `x-ai-service-token` on every real endpoint,
compared in constant time.

**§10, §35 — the AI never publishes.** This service returns text. It has no
database connection and no write path of any kind.

## Layout

```
app/
  main.py            FastAPI app, CORS, one error shape for the Node API
  config.py          env loading (root .env + local .env) and the USE_GROQ switch
  security.py        shared-secret check for service-to-service calls
  providers/         base interface + groq.py + openai.py + gemini.py + normalised errors
  prompts/           system rules (§23/§24/§35/§38) and per-feature user prompts
  schemas/           request/response models — the contract with the Node API
  services/          orchestration: llm runner, JSON repair, fact guard, features
  routers/           HTTP surface
```

Swapping in another provider means adding one file under `providers/` and one
branch in `providers/__init__.py`. Nothing above that layer changes (§29).
