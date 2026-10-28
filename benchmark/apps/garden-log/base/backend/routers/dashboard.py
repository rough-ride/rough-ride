"""Dashboard summary figures."""

import sqlite3
from datetime import date

from fastapi import APIRouter, Depends

from db import get_db
from schemas import SummaryOut
from security import require_user

router = APIRouter(
    prefix="/api/dashboard", tags=["dashboard"], dependencies=[Depends(require_user)]
)


@router.get("/summary", response_model=SummaryOut)
def summary(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    today = date.today()
    year_start = date(today.year, 1, 1).isoformat()
    year_end = date(today.year, 12, 31).isoformat()

    plant_count = conn.execute("SELECT COUNT(*) FROM plants").fetchone()[0]
    bed_count = conn.execute("SELECT COUNT(*) FROM beds").fetchone()[0]
    harvest_count, harvest_grams = conn.execute(
        """
        SELECT COUNT(*), COALESCE(SUM(weight_grams), 0)
        FROM harvests WHERE harvested_on BETWEEN ? AND ?
        """,
        (year_start, year_end),
    ).fetchone()
    open_count, overdue_count = conn.execute(
        """
        SELECT COUNT(*), COALESCE(SUM(CASE WHEN due_on < ? THEN 1 ELSE 0 END), 0)
        FROM tasks WHERE done = 0
        """,
        (today.isoformat(),),
    ).fetchone()
    top = conn.execute(
        """
        SELECT p.name FROM harvests h JOIN plants p ON p.id = h.plant_id
        WHERE h.harvested_on BETWEEN ? AND ?
        GROUP BY p.id ORDER BY SUM(h.weight_grams) DESC, p.name LIMIT 1
        """,
        (year_start, year_end),
    ).fetchone()

    return {
        "year": today.year,
        "plant_count": plant_count,
        "bed_count": bed_count,
        "harvest_count_year": harvest_count,
        "harvest_grams_year": harvest_grams,
        "open_task_count": open_count,
        "overdue_task_count": overdue_count,
        "top_plant": top[0] if top else None,
    }
