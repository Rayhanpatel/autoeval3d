"""
Auto-Eval3D — SQLite Database Module
Handles initialization and paginated queries for evaluation history.
"""

import sqlite3
import os
import math

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "evaluations.db")


def get_connection():
    """Get a SQLite connection with row factory enabled."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the evaluations table if it doesn't exist."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS evaluations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            spz_url TEXT NOT NULL,
            spatial_thinking TEXT NOT NULL,
            thinking TEXT NOT NULL,
            answer TEXT NOT NULL,
            score INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_created_at ON evaluations(created_at DESC)
    """)
    conn.commit()
    conn.close()


def save_evaluation(prompt: str, operation_id: str, spz_url: str,
                    spatial_thinking: str, thinking: str, answer: str,
                    score: int) -> int:
    """Save an evaluation result and return the new row ID."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO evaluations (prompt, operation_id, spz_url, spatial_thinking, thinking, answer, score)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (prompt, operation_id, spz_url, spatial_thinking, thinking, answer, score))
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_evaluations(page: int = 1, limit: int = 10) -> dict:
    """Retrieve paginated evaluation history."""
    conn = get_connection()
    cursor = conn.cursor()

    # Total count
    cursor.execute("SELECT COUNT(*) as count FROM evaluations")
    total_records = cursor.fetchone()["count"]
    total_pages = max(1, math.ceil(total_records / limit))

    # Clamp page
    page = max(1, min(page, total_pages))
    offset = (page - 1) * limit

    cursor.execute("""
        SELECT id, prompt, operation_id, spz_url, spatial_thinking, thinking, answer, score, created_at
        FROM evaluations
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    """, (limit, offset))

    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()

    return {
        "data": rows,
        "meta": {
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "total_records": total_records,
        }
    }
