from __future__ import annotations

import os
import secrets
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, status

from .agent import AgentRequest, AgentResponse, run_agent

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

service_token = os.getenv("AI_SERVICE_TOKEN", "")
if os.getenv("NODE_ENV") == "production" and len(service_token) < 32:
    raise RuntimeError("AI_SERVICE_TOKEN must contain at least 32 characters in production.")

app = FastAPI(
    title="Stride Assistant",
    description="A tenant-scoped, tool-using task assistant for Stride workspaces.",
    version="1.0.0",
)


async def require_service_token(authorization: str | None = Header(default=None)) -> None:
    expected = f"Bearer {service_token}"
    if not service_token or not authorization or not secrets.compare_digest(
        authorization, expected
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This endpoint is only available to the Stride API.",
        )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "stride-assistant"}


@app.post(
    "/v1/assistant/run",
    response_model=AgentResponse,
    dependencies=[Depends(require_service_token)],
)
async def run_assistant(request: AgentRequest) -> AgentResponse:
    return run_agent(request)
