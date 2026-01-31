from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="PrecisionMed Inference", version="0.1.0")


class InsightRequest(BaseModel):
    patient_id: str
    top_k: int = 3


class InsightResponse(BaseModel):
    insights: list[str]
    source: str = "inference-stub"


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/insights", response_model=InsightResponse)
async def insights(payload: InsightRequest):
    dummy = [f"insight-{i+1}-for-{payload.patient_id}" for i in range(payload.top_k)]
    return InsightResponse(insights=dummy)
