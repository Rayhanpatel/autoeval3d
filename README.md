# 🌐 Auto-Eval3D — ViewFusion Spatial Coherence Evaluator

> **BigThink x World Labs Hackathon** — Best Scientific & Engineering Application Track

An automated spatial coherence evaluation pipeline that generates 3D Gaussian Splat worlds using World Labs' Marble API, programmatically captures multi-view perspectives, and evaluates geometric consistency using Gemini 2.5 Pro with structured ViewFusion reasoning.

## 🧠 Theoretical Foundation

Auto-Eval3D bridges two cutting-edge research papers:

- **Think3D** (arXiv, March 2026): Demonstrates that spatial intelligence dramatically improves when a VLM actively explores a 3D environment rather than passively observing a single image.
- **ViewFusion** (arXiv, March 2026): Proves that VLMs fail at multi-view reasoning without a structured "think twice" process separating spatial pre-alignment from question answering.

By combining Think3D's **active exploration** with ViewFusion's **structured reasoning**, Auto-Eval3D creates a fully automated spatial reward evaluator.

## ⚡ Pipeline

```
User Prompt → Marble API → .spz URL → SparkJS 3D Viewer
    → 4-Way Camera Orbit → Screenshot Capture
    → Gemini 2.5 Pro (ViewFusion Prompting)
    → Spatial Coherence Scorecard (1-10)
```

## 🏗️ Architecture

| Component        | Technology                              |
|------------------|-----------------------------------------|
| Backend Proxy    | Python + FastAPI + Uvicorn              |
| 3D Renderer      | THREE.js + SparkJS 2.0 (Gaussian Splats)|
| VLM Evaluator    | Gemini 2.5 Pro via Vertex AI            |
| World Generator  | World Labs Marble 0.1-mini API          |
| Database         | SQLite (local)                          |
| Frontend         | Vanilla HTML/CSS/JS                     |

## 🚀 Quick Start

### Prerequisites
- Python 3.10+
- Google Cloud SDK with ADC configured
- World Labs Platform API key

### Setup

```bash
# 1. Authenticate Google Cloud (for Vertex AI)
gcloud auth application-default login

# 2. Create environment file
cp .env.example .env
# Edit .env with your API keys

# 3. Install Python dependencies
pip install -r backend/requirements.txt

# 4. Start the server
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# 5. Open browser
open http://localhost:8000
```

## 📁 Project Structure

```
autoeval3d/
├── backend/
│   ├── main.py           # FastAPI server with proxy & evaluation endpoints
│   ├── database.py       # SQLite init and paginated queries
│   └── requirements.txt  # Python dependencies
├── frontend/
│   ├── index.html        # Semantic HTML5 structure
│   ├── style.css         # Dark premium design system
│   └── app.js            # THREE.js + SparkJS + orchestration
├── .env                  # API keys (not committed)
├── .env.example          # Template for API keys
└── README.md             # You're here
```

## 🔑 API Endpoints

| Method | Path               | Description                     |
|--------|--------------------|---------------------------------|
| POST   | `/api/generate`    | Generate 3D world via Marble    |
| POST   | `/api/evaluate`    | Evaluate 4 viewpoints via Gemini|
| GET    | `/api/evaluations` | Paginated history               |
| GET    | `/api/status/{id}` | Poll async generation status    |
| POST   | `/api/webhooks/marble` | Completion webhook          |

## 📝 References

- Think3D: *Thinking with Space for Spatial Reasoning*. [arXiv 2601.13029](https://arxiv.org/html/2601.13029v3)
- ViewFusion: *Structured Spatial Thinking Chains for Multi-View Reasoning*. [arXiv 2603.06024](https://arxiv.org/html/2603.06024v1)
- [World Labs Marble API](https://docs.worldlabs.ai/api)
- [SparkJS Gaussian Splatting Renderer](https://github.com/sparkjsdev/spark)

---

Built with 🤖 AI assistance for the BigThink x World Labs Hackathon at UMD Iribe Center, March 28, 2026.
