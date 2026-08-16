import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import routes_jobs, routes_paper, routes_scenarios, routes_simulate

app = FastAPI(
    title="EV Dynamic Pricing Simulator API",
    description=(
        "REST API around the tri-level EV charging-station pricing simulator "
        "(traffic dynamics + replicator routing + gradient-flow pricing)."
    ),
    version="1.0.0",
)

allowed_origins = os.environ.get("CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes_scenarios.router, prefix="/api")
app.include_router(routes_simulate.router, prefix="/api")
app.include_router(routes_paper.router, prefix="/api")
app.include_router(routes_jobs.router, prefix="/api")

# In production we serve the built React app straight from FastAPI so the
# whole project deploys as one web service (see README "Deployment").
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
