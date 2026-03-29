"""
Auto-Eval3D — FastAPI Backend
Proxy server for World Labs Marble API and Gemini 2.5 Pro evaluation.

Endpoints:
  POST /api/generate       — Generate a 3D world via Marble API
  POST /api/evaluate       — Evaluate 4 viewpoint images via Gemini 2.5 Pro
  GET  /api/evaluations    — Paginated evaluation history
  GET  /api/status/{id}    — Poll async generation status (proxy to Marble API)
"""

import os
import re
import json
import asyncio
import logging
import base64
from typing import Optional
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx

import vertexai
from vertexai.generative_models import GenerativeModel, Part

from database import init_db, save_evaluation, get_evaluations

# ── Load environment ──
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

WLT_API_KEY = os.getenv("WLT_API_KEY", "")
GOOGLE_CLOUD_PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "")
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-pro")

MARBLE_BASE = "https://api.worldlabs.ai/marble/v1"

# ── Logging ──
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("autoeval3d")

# ── Init Vertex AI ──
if GOOGLE_CLOUD_PROJECT:
    vertexai.init(project=GOOGLE_CLOUD_PROJECT, location=GOOGLE_CLOUD_LOCATION)

# ── Lifespan (replaces deprecated @app.on_event) ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("Auto-Eval3D backend started")
    yield
    logger.info("Auto-Eval3D backend shutting down")

# ── FastAPI App ──
app = FastAPI(title="Auto-Eval3D", version="1.0.0", lifespan=lifespan)


# ── Request models ──
class GenerateRequest(BaseModel):
    prompt: str
    model: str = "Marble 0.1-mini"


class EvaluateRequest(BaseModel):
    operation_id: str
    spz_url: str
    prompt: str
    images: list[str]  # base64 data URIs


# ── Endpoint 1: Generate World ──
@app.post("/api/generate")
async def generate_world(req: GenerateRequest):
    """Proxy to World Labs Marble API with polling loop."""
    if not WLT_API_KEY:
        raise HTTPException(status_code=500, detail="WLT_API_KEY not configured")

    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")

    headers = {
        "Content-Type": "application/json",
        "WLT-Api-Key": WLT_API_KEY,
    }

    payload = {
        "display_name": req.prompt[:64],
        "world_prompt": {
            "type": "text",
            "text_prompt": req.prompt,
        },
    }

    # Only inject model field for mini to use draft mode
    if req.model == "Marble 0.1-mini":
        payload["model"] = "Marble 0.1-mini"

    # Use separate timeouts: short for initial request, no limit for polling
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        # Step 1: Initiate generation
        try:
            resp = await client.post(
                f"{MARBLE_BASE}/worlds:generate",
                headers=headers,
                json=payload,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            logger.error(f"Marble API error {e.response.status_code}: {error_body}")
            if e.response.status_code == 429:
                raise HTTPException(
                    status_code=429,
                    detail="Rate limited by Marble API (~6 req/min). Please wait 10 seconds and try again."
                )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Marble API error: {error_body[:500]}"
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach Marble API: {e}")

        data = resp.json()
        operation_id = data.get("operation_id", "")

        if not operation_id:
            raise HTTPException(status_code=502, detail="No operation_id returned from Marble API")

        # For high-fidelity, return the operation_id for frontend to poll /api/status/{id}
        if req.model != "Marble 0.1-mini":
            return {
                "operation_id": operation_id,
                "status": "in_progress",
                "message": "High-fidelity generation started. Poll /api/status/{operation_id} for updates."
            }

    # Step 2: Poll for draft completion (separate client with generous timeout)
    logger.info(f"Polling operation {operation_id} for draft generation...")
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as poll_client:
        for attempt in range(60):  # max 60 * 2s = 120s timeout
            await asyncio.sleep(2)
            try:
                poll_resp = await poll_client.get(
                    f"{MARBLE_BASE}/operations/{operation_id}",
                    headers={"WLT-Api-Key": WLT_API_KEY},
                )
                poll_resp.raise_for_status()
            except httpx.HTTPStatusError:
                continue

            poll_data = poll_resp.json()

            if poll_data.get("done"):
                return _extract_generation_result(poll_data, operation_id)

            # Log progress
            metadata = poll_data.get("metadata", {})
            progress = metadata.get("progress", {})
            logger.info(f"  Poll #{attempt+1}: {progress.get('status', 'unknown')} - {progress.get('description', '')}")

    raise HTTPException(status_code=504, detail="Generation timed out after 120 seconds")


# ── Endpoint 2: Evaluate Scene ──
@app.post("/api/evaluate")
async def evaluate_scene(req: EvaluateRequest):
    """Send 4 viewpoint images to Gemini 2.5 Pro with ViewFusion prompting."""
    if not GOOGLE_CLOUD_PROJECT:
        raise HTTPException(status_code=500, detail="GOOGLE_CLOUD_PROJECT not configured")

    if len(req.images) != 4:
        raise HTTPException(status_code=400, detail="Exactly 4 viewpoint images are required")

    # Build the ViewFusion system instruction (elevated authority)
    system_instruction = """You are an expert spatial coherence evaluator for AI-generated 3D environments.

You are given 4 screenshots captured from different viewpoints of the same 3D Gaussian Splat scene.
The original prompt used to generate this world was: "{prompt}"

Your task is to evaluate the spatial coherence, geometric consistency, and prompt alignment of this 3D world.

You MUST structure your response using the following XML tags:

<spatial_thinking>
Cross-View Spatial Pre-Alignment:
Analyze each image pair for geometric consistency. Check for:
- Objects that appear in one view but vanish in another
- Surfaces that warp, stretch, or change shape between views
- Scale inconsistencies between near and far objects
- Lighting direction inconsistencies across views
- Floating geometry or objects disconnected from surfaces
- Objects with multiple faces (Janus artifacts)
- Ground plane discontinuities
</spatial_thinking>

<thinking>
Reasoning and Evaluation:
Based on your spatial analysis, reason about the overall quality:
- Does the scene match the text prompt?
- Are there physical impossibilities?
- Rate each category: Geometric Consistency, Prompt Alignment, Physical Plausibility, Visual Quality
</thinking>

<answer>
Final Assessment:
Provide a concise summary of findings, listing specific artifacts found.
End with a single integer SCORE from 1-10 where:
1-3 = Severe spatial failures (floating objects, Janus artifacts, missing geometry)
4-5 = Noticeable issues but recognizable scene
6-7 = Minor inconsistencies, generally coherent
8-9 = High quality with very minor issues
10 = Perfect spatial coherence

SCORE: [your score]
</answer>""".format(prompt=req.prompt)

    # Prepare image parts for Gemini (images + viewpoint labels only)
    content_parts = ["Here are the 4 viewpoint images:\n"]

    for i, img_data_uri in enumerate(req.images):
        # Strip data URI prefix: "data:image/jpeg;base64,..."
        if "base64," in img_data_uri:
            b64_data = img_data_uri.split("base64,")[1]
        else:
            b64_data = img_data_uri

        image_bytes = base64.b64decode(b64_data)
        content_parts.append(Part.from_data(data=image_bytes, mime_type="image/jpeg"))
        content_parts.append(f"\n[Image {i+1}: Viewpoint at {i * 90}° azimuth]\n")

    # Call Gemini 2.5 Pro with system_instruction for elevated prompt authority
    try:
        model = GenerativeModel(
            GEMINI_MODEL,
            system_instruction=system_instruction,
        )
        response = model.generate_content(
            content_parts,
            generation_config={
                "temperature": 0.2,
                "max_output_tokens": 4096,
            }
        )
        raw_text = response.text
    except Exception as e:
        logger.error(f"Gemini API error: {e}")
        raise HTTPException(status_code=502, detail=f"Gemini evaluation failed: {str(e)}")

    # Parse the XML tags from response
    spatial_thinking = _extract_tag(raw_text, "spatial_thinking")
    thinking = _extract_tag(raw_text, "thinking")
    answer = _extract_tag(raw_text, "answer")

    # Extract score from answer
    score = _extract_score(answer)

    # Save to database (sync function called from async — FastAPI runs sync
    # functions called directly in a threadpool via run_in_executor internally,
    # but since save_evaluation is fast, blocking here is acceptable for hackathon)
    eval_id = await asyncio.get_event_loop().run_in_executor(
        None,
        save_evaluation,
        req.prompt,
        req.operation_id,
        req.spz_url,
        spatial_thinking,
        thinking,
        answer,
        score,
    )

    return {
        "id": eval_id,
        "spatial_thinking": spatial_thinking,
        "thinking": thinking,
        "answer": answer,
        "score": score,
    }


# ── Endpoint 3: History ──
# Using `def` (not `async def`) so FastAPI automatically runs it in a threadpool,
# preventing the synchronous SQLite from blocking the async event loop.
@app.get("/api/evaluations")
def list_evaluations(page: int = 1, limit: int = 10):
    """Return paginated evaluation history."""
    return get_evaluations(page=page, limit=limit)


# ── Endpoint 4: Async status polling (proxy to Marble API) ──
@app.get("/api/status/{operation_id}")
async def get_status(operation_id: str):
    """Poll the Marble API directly for generation status."""
    if not WLT_API_KEY:
        raise HTTPException(status_code=500, detail="WLT_API_KEY not configured")

    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        try:
            resp = await client.get(
                f"{MARBLE_BASE}/operations/{operation_id}",
                headers={"WLT-Api-Key": WLT_API_KEY},
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=str(e))
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Failed to reach Marble API: {e}")

        poll_data = resp.json()

        if poll_data.get("done"):
            result = _extract_generation_result(poll_data, operation_id)
            return {"status": "completed", **result}

        # Return progress info
        metadata = poll_data.get("metadata", {})
        progress = metadata.get("progress", {})
        return {
            "status": "in_progress",
            "progress_status": progress.get("status", "unknown"),
            "progress_description": progress.get("description", ""),
        }


# ── Utilities ──
def _extract_generation_result(poll_data: dict, operation_id: str) -> dict:
    """Extract SPZ URL and metadata from a completed Marble API response."""
    response_obj = poll_data.get("response", {})
    assets = response_obj.get("assets", {})
    splats = assets.get("splats", {})
    spz_urls = splats.get("spz_urls", {})

    # Prefer 500k resolution for balance of quality and speed
    spz_url = spz_urls.get("500k") or spz_urls.get("full_res") or spz_urls.get("100k", "")

    if not spz_url:
        raise HTTPException(status_code=502, detail="Generation completed but no SPZ URL found")

    return {
        "operation_id": operation_id,
        "spz_url": spz_url,
        "status": "completed",
        "world_id": response_obj.get("id", ""),
        "caption": assets.get("caption", ""),
        "thumbnail_url": assets.get("thumbnail_url", ""),
    }


def _extract_tag(text: str, tag: str) -> str:
    """Extract text between XML tags."""
    pattern = rf"<{tag}>(.*?)</{tag}>"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1).strip() if match else ""


def _extract_score(answer_text: str) -> int:
    """Extract integer score from the answer text."""
    match = re.search(r"SCORE:\s*(\d+)", answer_text)
    if match:
        return max(1, min(10, int(match.group(1))))
    # Fallback: look for any digit at the end
    match = re.search(r"(\d+)\s*$", answer_text)
    if match:
        return max(1, min(10, int(match.group(1))))
    return 5  # default middle score


# ── Serve Frontend ──
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/static", StaticFiles(directory=frontend_dir), name="frontend")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(frontend_dir, "index.html"))


# ── Run ──
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
