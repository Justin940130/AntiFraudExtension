
import sqlite3
import hashlib
import json
from contextlib import closing
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path(__file__).resolve().parent / "antifraud.db"

# 如果日後修改模型或 Prompt，就更新這個版本
CACHE_VERSION = "flash-lite-v1"


def get_hash(text):
    # 使用版本與訊息內容建立快取鍵
    content = CACHE_VERSION + "\0" + text
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def init_db():
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as conn, conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS analysis_cache (
                message_hash TEXT PRIMARY KEY,
                risk_level TEXT NOT NULL,
                category TEXT NOT NULL,
                model_version TEXT NOT NULL,
                latency_ms INTEGER NOT NULL,
                analyzed_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS context_cache (
                message_hash TEXT PRIMARY KEY,
                result_json TEXT NOT NULL
            )
        """)


def get_context_result(key):
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as conn:
        row = conn.execute("SELECT result_json FROM context_cache WHERE message_hash = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def save_context_result(key, result):
    # Evidence is represented by offsets. The conversation text stays out of SQLite.
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO context_cache VALUES (?, ?)", (key, json.dumps(result)))



def get_cached_result(text):
    message_hash = get_hash(text)

    with closing(sqlite3.connect(DB_PATH, timeout=10)) as conn, conn:
        row = conn.execute("""
            SELECT risk_level, category
            FROM analysis_cache
            WHERE message_hash = ?
        """, (message_hash,)).fetchone()

    if row is None:
        return None

    return {
        "risk_level": row[0],
        "category": row[1]
    }


def save_result(text, risk_level, category, latency_ms):
    if risk_level not in ("high", "medium", "low"):
        return

    message_hash = get_hash(text)

    with closing(sqlite3.connect(DB_PATH, timeout=10)) as conn, conn:
        conn.execute("""
            INSERT OR REPLACE INTO analysis_cache
            (message_hash, risk_level, category,
             model_version, latency_ms, analyzed_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            message_hash,
            risk_level,
            category,
            CACHE_VERSION,
            latency_ms,
            datetime.now(timezone.utc).isoformat()
        ))
