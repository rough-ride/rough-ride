"""Harvest log entries."""

import sqlite3

from fastapi import APIRouter, Depends, Query, Response, status

from db import get_db
from routers.common import ensure_plant_exists, not_found
from schemas import HarvestIn, HarvestOut
from security import require_user

router = APIRouter(
    prefix="/api/harvests", tags=["harvests"], dependencies=[Depends(require_user)]
)

HARVEST_SELECT = """
SELECT h.id, h.plant_id, p.name AS plant_name, h.weight_grams, h.harvested_on, h.notes
FROM harvests h
JOIN plants p ON p.id = h.plant_id
"""


def _get_harvest(conn: sqlite3.Connection, harvest_id: int) -> dict:
    row = conn.execute(HARVEST_SELECT + " WHERE h.id = ?", (harvest_id,)).fetchone()
    if row is None:
        raise not_found("Harvest")
    return dict(row)


@router.get("", response_model=list[HarvestOut])
def list_harvests(
    plant_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=50, ge=1, le=500),
    conn: sqlite3.Connection = Depends(get_db),
) -> list[dict]:
    where, params = "", []
    if plant_id is not None:
        where, params = " WHERE h.plant_id = ?", [plant_id]
    rows = conn.execute(
        HARVEST_SELECT + where + " ORDER BY h.harvested_on DESC, h.id DESC LIMIT ?",
        [*params, limit],
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("", response_model=HarvestOut, status_code=status.HTTP_201_CREATED)
def create_harvest(payload: HarvestIn, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    ensure_plant_exists(conn, payload.plant_id)
    cur = conn.execute(
        """
        INSERT INTO harvests (plant_id, weight_grams, harvested_on, notes)
        VALUES (?, ?, ?, ?)
        """,
        (
            payload.plant_id,
            payload.weight_grams,
            payload.harvested_on.isoformat(),
            payload.notes,
        ),
    )
    conn.commit()
    return _get_harvest(conn, cur.lastrowid)


@router.delete("/{harvest_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_harvest(harvest_id: int, conn: sqlite3.Connection = Depends(get_db)) -> Response:
    _get_harvest(conn, harvest_id)
    conn.execute("DELETE FROM harvests WHERE id = ?", (harvest_id,))
    conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
