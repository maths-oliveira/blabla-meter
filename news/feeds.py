"""RSS/Atom fetching with the standard library only."""

import hashlib
import html
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone

UA = "Mozilla/5.0 (X11; Linux x86_64) usefulnews/1.0"

DEFAULT_FEEDS = [
    {"name": "g1", "url": "https://g1.globo.com/rss/g1/"},
    {"name": "Folha", "url": "https://feeds.folha.uol.com.br/emcimadahora/rss091.xml"},
    {"name": "BBC Brasil", "url": "https://feeds.bbci.co.uk/portuguese/rss.xml"},
    {"name": "Tecnoblog", "url": "https://tecnoblog.net/feed/"},
    {"name": "Hacker News", "url": "https://hnrss.org/frontpage"},
    {"name": "The Verge", "url": "https://www.theverge.com/rss/index.xml"},
]


def local_feed(location: str) -> dict:
    """Google News search for the reader's city/region (regional news is usually the most actionable)."""
    q = urllib.parse.quote(location.strip())
    return {"name": f"Local · {location.strip()}",
            "url": f"https://news.google.com/rss/search?q={q}&hl=pt-BR&gl=BR&ceid=BR:pt-419"}


def clean_text(value: str, limit: int = 600) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _date(value: str) -> int:
    value = (value or "").strip()
    if not value:
        return 0
    try:
        return int(parsedate_to_datetime(value).timestamp())
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def article_id(url: str, title: str) -> str:
    return hashlib.sha1((url or title).strip().encode("utf-8")).hexdigest()[:16]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child(el, *names):
    for c in el:
        if _local(c.tag) in names:
            return c
    return None


def parse_feed(xml_bytes: bytes, source: str) -> list:
    root = ET.fromstring(xml_bytes)
    out = []
    for el in root.iter():
        kind = _local(el.tag)
        if kind not in ("item", "entry"):
            continue
        title_el = _child(el, "title")
        title = clean_text(title_el.text if title_el is not None else "", 300)
        if not title:
            continue
        link = ""
        link_el = _child(el, "link")
        if link_el is not None:
            link = (link_el.get("href") or link_el.text or "").strip()
        summary_el = _child(el, "description", "summary", "content")
        summary = clean_text("".join(summary_el.itertext()) if summary_el is not None else "")
        date_el = _child(el, "pubdate", "published", "updated", "date")
        published = _date(date_el.text if date_el is not None else "")
        out.append({
            "id": article_id(link, title), "url": link, "title": title,
            "summary": summary if summary.lower() != title.lower() else "",
            "source": source, "published": published,
        })
    return out


def fetch_feed(feed: dict, timeout: int = 20) -> tuple:
    """(articles, error)"""
    try:
        req = urllib.request.Request(feed["url"], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return parse_feed(resp.read(), feed.get("name") or feed["url"]), ""
    except Exception as exc:  # one bad feed must not stop the others
        return [], f"{feed.get('name') or feed['url']}: {exc}"


def fetch_all(feeds: list, per_feed: int = 25) -> tuple:
    articles, errors, seen = [], [], set()
    with ThreadPoolExecutor(max_workers=8) as pool:
        for items, err in pool.map(fetch_feed, feeds):
            if err:
                errors.append(err)
            for a in items[:per_feed]:
                if a["id"] not in seen:
                    seen.add(a["id"])
                    articles.append(a)
    now = int(datetime.now(timezone.utc).timestamp())
    for a in articles:
        a["published"] = a["published"] or now
    return articles, errors
