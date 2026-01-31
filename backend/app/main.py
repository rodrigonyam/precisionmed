from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import httpx
import asyncpg
from .config import get_settings, Settings

app = FastAPI(title="PrecisionMed API", version="0.1.0")


class HealthResponse(BaseModel):
    status: str
    omop_db: str


class InsightRequest(BaseModel):
    patient_id: str
    top_k: int = 3


class InsightResponse(BaseModel):
    insights: list[str]
    source: str


async def get_db(settings: Settings):
    conn = await asyncpg.connect(
        host=settings.omop_db_host,
        port=settings.omop_db_port,
        database=settings.omop_db_name,
        user=settings.omop_db_user,
        password=settings.omop_db_password,
        ssl="require" if settings.omop_db_sslmode == "require" else None,
    )
    try:
        yield conn
    finally:
        await conn.close()


@app.get("/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)):
    return HealthResponse(status="ok", omop_db=settings.omop_db_host)


@app.get("/ehr/patient")
async def proxy_patient(patient_id: str, settings: Settings = Depends(get_settings)):
    if not settings.fhir_datastore_endpoint:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="FHIR endpoint not configured")
    url = f"{settings.fhir_datastore_endpoint}/r4/Patient/{patient_id}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        return JSONResponse(content=resp.json())


@app.post("/smart/callback")
async def smart_callback(code: str):
    # Placeholder SMART on FHIR auth handler; in production call your SMART authorizer Lambda.
    return {"message": "SMART callback received", "code": code, "token": "exchange-with-authorizer"}


@app.post("/insights", response_model=InsightResponse)
async def insights(payload: InsightRequest, settings: Settings = Depends(get_settings)):
    if not settings.inference_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Inference URL not configured")
    body = payload.model_dump()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(settings.inference_url, json=body)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)
        data = resp.json()
        return InsightResponse(insights=data.get("insights", []), source=settings.inference_url)


@app.get("/config")
async def config(settings: Settings = Depends(get_settings)):
    return {
        "env": settings.app_env,
        "fhir_endpoint": settings.fhir_datastore_endpoint,
        "smart_issuer": settings.smart_issuer,
        "smart_client_id": settings.smart_client_id,
    }
