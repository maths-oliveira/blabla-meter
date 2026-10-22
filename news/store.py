"""SQLite storage: articles, raw judgments per scorer, feedback. Settings/memory are JSON files."""

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, url TEXT, title TEXT, summary TEXT, source TEXT,
  published INTEGER, fetched INTEGER);
CREATE TABLE IF NOT EXISTS judgments (
  article_id TEXT, scorer TEXT, profile_hash TEXT, dims TEXT, created INTEGER,
  PRIMARY KEY (article_id, scorer));
CREATE TABLE IF NOT EXISTS feedback (
  article_id TEXT PRIMARY KEY, vote INTEGER, user_score INTEGER, note TEXT,
  model_score INTEGER, topic TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published);
"""


def profile_hash(profile: dict, memory: dict) -> str:
    """Judgments depend on the reader state; this tells when they are stale."""
    key = {"p": profile, "r": memory.get("rules") or []}
    if memory.get("page_rules"):  # only when present, so existing hashes stay valid
        key["w"] = memory["page_rules"]
    key = json.dumps(key, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(key.encode()).hexdigest()[:12]


class Store:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.db = sqlite3.connect(self.dir / "news.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ------------------------------------------------------------ json files
    def read_json(self, name: str, default):
        try:
            return json.loads((self.dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def write_json(self, name: str, data) -> None:
        tmp = self.dir / (name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.dir / name)

    # ------------------------------------------------------------ articles
    def add_articles(self, articles: list) -> int:
        now = int(time.time())
        with self.lock:
            before = self.db.total_changes
            self.db.executemany(
                "INSERT OR IGNORE INTO articles VALUES (?,?,?,?,?,?,?)",
                [(a["id"], a["url"], a["title"], a["summary"], a["source"], a["published"], now) for a in articles])
            self.db.commit()
            return self.db.total_changes - before

    def recent(self, days: int = 3, limit: int = 400) -> list:
        since = int(time.time()) - days * 86400
        with self.lock:
            rows = self.db.execute(
                "SELECT * FROM articles WHERE published >= ? ORDER BY published DESC LIMIT ?", (since, limit)).fetchall()
        return [dict(r) for r in rows]

    def article(self, aid: str):
        with self.lock:
            r = self.db.execute("SELECT * FROM articles WHERE id = ?", (aid,)).fetchone()
        return dict(r) if r else None

    # ------------------------------------------------------------ judgments
    def judgments(self, scorer: str, ids: list) -> dict:
        if not ids:
            return {}
        out = {}
        with self.lock:
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                q = f"SELECT * FROM judgments WHERE scorer = ? AND article_id IN ({','.join('?' * len(chunk))})"
                for r in self.db.execute(q, (scorer, *chunk)):
                    out[r["article_id"]] = {"dims": json.loads(r["dims"]), "profile_hash": r["profile_hash"]}
        return out

    def save_judgments(self, scorer: str, phash: str, results: dict) -> None:
        now = int(time.time())
        with self.lock:
            self.db.executemany(
                "INSERT OR REPLACE INTO judgments VALUES (?,?,?,?,?)",
                [(aid, scorer, phash, json.dumps(d), now) for aid, d in results.items() if not aid.startswith("_")])
            self.db.commit()

    # ------------------------------------------------------------ feedback
    def save_feedback(self, aid: str, vote, user_score, note: str, model_score, topic: str) -> None:
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO feedback VALUES (?,?,?,?,?,?,?)",
                            (aid, vote, user_score, note, model_score, topic, int(time.time())))
            self.db.commit()

    def delete_feedback(self, aid: str) -> None:
        with self.lock:
            self.db.execute("DELETE FROM feedback WHERE article_id = ?", (aid,))
            self.db.commit()

    def feedback(self) -> list:
        with self.lock:
            rows = self.db.execute(
                "SELECT f.*, a.title, a.source FROM feedback f LEFT JOIN articles a ON a.id = f.article_id "
                "ORDER BY f.created").fetchall()
        return [dict(r) for r in rows]
