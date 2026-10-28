"""Garden Log API: FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import connect, create_schema
from routers import auth, beds, dashboard, harvests, plants, tasks

ALLOWED_ORIGINS = ["http://localhost:3701"]


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    conn = connect()
    try:
        create_schema(conn)
        conn.commit()
    finally:
        conn.close()
    yield


app = FastAPI(title="Garden Log API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)

for router_module in (auth, beds, plants, harvests, tasks, dashboard):
    app.include_router(router_module.router)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok"}
