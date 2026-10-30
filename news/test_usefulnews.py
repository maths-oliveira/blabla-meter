import os
import tempfile
import unittest
from unittest import mock

os.environ["USEFULNEWS_CONFIG_DIR"] = tempfile.mkdtemp()
os.environ["USEFULNEWS_DATA_DIR"] = tempfile.mkdtemp()
os.environ["BBLA_SHARED_RULES"] = os.path.join(tempfile.mkdtemp(), "shared-rules.json")

import app as webapp  # noqa: E402
import feeds  # noqa: E402
import scoring  # noqa: E402

RSS = b"""<?xml version="1.0"?><rss><channel>
<item><title>Nova ferramenta de IA gr&#225;tis</title><link>https://ex.com/a</link>
<description>&lt;p&gt;Dispon&#237;vel hoje&lt;/p&gt;</description><pubDate>Tue, 29 Sep 2026 10:00:00 +0000</pubDate></item>
<item><title>  </title><link>https://ex.com/empty</link></item>
</channel></rss>"""
ATOM = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom post</title>
<link href="https://ex.com/b"/><updated>2026-09-29T12:00:00Z</updated><summary>Short</summary></entry></feed>"""


def dims(a=0.9, r=0.9, i=0.5, d=0.5, **flags):
    return {"scores": {"actionable": a, "relevance": r, "impact": i, "depth": d},
            "flags": {k: flags.get(k, 0.0) for k in scoring.FLAGS}, "topic": flags.get("topic", "tech_tool")}


class Feeds(unittest.TestCase):
    def test_rss(self):
        items = feeds.parse_feed(RSS, "Ex")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "Nova ferramenta de IA grátis")
        self.assertEqual(items[0]["summary"], "Disponível hoje")
        self.assertGreater(items[0]["published"], 0)

    def test_atom(self):
        items = feeds.parse_feed(ATOM, "Ex")
        self.assertEqual((items[0]["url"], items[0]["summary"]), ("https://ex.com/b", "Short"))

    def test_bad_feed_reported_not_raised(self):
        with mock.patch.object(feeds.urllib.request, "urlopen", side_effect=OSError("boom")):
            arts, errs = feeds.fetch_all([{"name": "X", "url": "http://x"}])
        self.assertEqual(arts, [])
        self.assertIn("boom", errs[0])


class Usefulness(unittest.TestCase):
    def test_flags_penalize(self):
        good = scoring.usefulness(dims())["value"]
        bait = scoring.usefulness(dims(clickbait=1.0, gossip=1.0))["value"]
        self.assertGreater(good, 70)
        self.assertLess(bait, good * 0.4)

    def test_memory_bias_and_clamp(self):
        mem = {"topic_bias": {"tech_tool": 15}, "source_bias": {"g1": -8}}
        u = scoring.usefulness(dims(1, 1, 1, 1), memory=mem, source="g1")
        self.assertEqual(u["value"], 100)  # 100 + 15 - 8, clamped
        self.assertEqual((u["topic_adj"], u["source_adj"]), (15.0, -8.0))

    def test_learn_biases(self):
        fb = [{"vote": -1, "topic": "politics", "source": "g1"}] * 3 + [
            {"vote": 1, "topic": "tech_tool", "source": "HN"},
            {"vote": 0, "topic": "tech_tool", "source": "HN", "user_score": 90, "model_score": 40}]
        b = scoring.learn_biases(fb)
        self.assertEqual(b["topic_bias"]["politics"], -7.5)
        self.assertGreater(b["topic_bias"]["tech_tool"], 0)
        self.assertLess(b["source_bias"]["g1"], 0)


class Jev(unittest.TestCase):
    def test_parses_answers(self):
        ans = {k: {"type": "score", "score": 3.0, "confidence": 0.9} for k in scoring.SCORES}
        ans.update({k: {"type": "noul", "noul": 0.1} for k in scoring.FLAGS})
        ans["topic"] = {"type": "choice", "choice": "local_event", "confidence": 0.8}
        s = scoring.JevScorer("k")
        with mock.patch.object(s, "_post", return_value={"answers": ans, "usage": {"input_tokens": 1000}}) as post:
            out = s.score([{"id": "x", "title": "T", "summary": "", "source": "s"}], {"location": "Curitiba"}, {"rules": ["likes AI"]})
        self.assertEqual(out["x"]["scores"]["actionable"], 1.0)
        self.assertEqual(out["x"]["topic"], "local_event")
        self.assertEqual(out["x"]["confidence"], 0.8)
        body = post.call_args[0][0]
        self.assertEqual(body["state"]["reader"], {"location": "Curitiba", "learned_preferences": ["likes AI"]})
        self.assertEqual(set(body["questions"]), {*scoring.SCORES, *scoring.FLAGS, "topic"})

    def test_llm_scorer_normalizes(self):
        fake = mock.Mock()
        fake.ask_json.return_value = {"results": [
            {"id": "x", "actionable": 3, "relevance": 9, "impact": "x", "depth": 1, "clickbait": 2, "topic": "nope"},
            {"id": "unknown", "actionable": 3}]}
        out = scoring.LLMScorer(fake).score([{"id": "x", "title": "T"}], {}, {})
        self.assertEqual(set(out), {"x"})
        self.assertEqual(out["x"]["scores"], {"actionable": 1.0, "relevance": 1.0, "impact": 0.0, "depth": 0.333})
        self.assertEqual((out["x"]["flags"]["clickbait"], out["x"]["topic"]), (1.0, "other"))


class Web(unittest.TestCase):
    def setUp(self):
        self.c = webapp.app.test_client()

    def test_refresh_score_feedback_flow(self):
        art = feeds.parse_feed(RSS, "Ex")[0]
        art["published"] = int(__import__("time").time())

        class FakeScorer:
            def score(self, articles, profile, memory):
                return {a["id"]: dims() for a in articles}

        with mock.patch.object(webapp.feedlib, "fetch_all", return_value=([art], [])), \
             mock.patch.object(webapp, "make_scorer", return_value=FakeScorer()):
            webapp.job["running"] = True
            webapp.refresh()
        self.assertEqual(webapp.job["stage"], "done")
        news = self.c.get("/api/news").json
        self.assertEqual(len(news["articles"]), 1)
        self.assertGreater(news["articles"][0]["useful"]["value"], 50)

        with mock.patch.object(webapp.threading, "Thread"):
            r = self.c.post("/api/feedback", json={"id": art["id"], "vote": -1, "note": "not for me"})
        self.assertEqual(r.status_code, 200)
        self.assertLess(r.json["memory"]["topic_bias"]["tech_tool"], 0)
        self.assertEqual(self.c.get("/api/news").json["articles"][0]["feedback"]["vote"], -1)

        # editing the rules changes the reader state → judgments become stale
        self.c.post("/api/memory", json={"rules": ["Prefers local news"]})
        self.assertTrue(self.c.get("/api/news").json["articles"][0]["stale"])

    def test_bad_score(self):
        self.assertEqual(self.c.post("/api/feedback", json={"id": "nope"}).status_code, 404)

    def test_settings_validation(self):
        r = self.c.post("/api/settings", json={"scorer": "llm", "weights": {"tragedy": 5, "bogus": 1},
                                               "feeds": [{"url": "ftp://x"}, {"name": "A", "url": "https://a/rss"}]})
        s = r.json["settings"]
        self.assertEqual(s["scorer"], "llm")
        self.assertEqual(s["weights"]["tragedy"], 1.0)
        self.assertNotIn("bogus", s["weights"])
        self.assertEqual(s["feeds"], [{"name": "A", "url": "https://a/rss"}])
        self.c.post("/api/settings", json={"scorer": "jev", "feeds": feeds.DEFAULT_FEEDS})

    def test_cross_origin_blocked(self):
        r = self.c.post("/api/settings", json={}, headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)



class SharedRules(unittest.TestCase):
    """Rules learned in the bbla page meter reach the news scorer, and news rules are shared back."""

    def test_page_rules_reach_reader_state_and_hash(self):
        import shared_rules
        from store import profile_hash
        before = profile_hash({"work": "dev"}, webapp.memory())
        shared_rules.write("page", ["press releases are blabla"])
        mem = webapp.memory()
        self.assertEqual(mem["page_rules"], ["press releases are blabla"])
        self.assertIn("press releases are blabla", scoring.reader_state({}, mem)["learned_from_web_pages"])
        self.assertNotEqual(before, profile_hash({"work": "dev"}, mem))
        webapp.save_memory(mem)
        self.assertNotIn("page_rules", webapp.store.read_json("memory.json", {}))
        shared_rules.write("page", [])

    def test_relearn_publishes_news_rules(self):
        import shared_rules
        with mock.patch.object(webapp.store, "feedback", return_value=[{"vote": 1, "note": "x", "topic": "tech tool"}]), \
             mock.patch.object(scoring, "distill_rules", return_value=["likes new dev tools"]), \
             mock.patch.object(scoring, "learn_biases", return_value={}):
            webapp.relearn()
        self.assertEqual(shared_rules.read()["news"], ["likes new dev tools"])

    def test_malformed_file_is_ignored(self):
        import shared_rules
        p = shared_rules.path()
        saved = p.read_text() if p.exists() else None
        try:
            for raw in ("[]", '"x"', '{"page": "be brief", "updated": 3}'):
                p.write_text(raw)
                self.assertEqual(shared_rules.read(), {"page": [], "news": [], "updated": {}})
            self.assertEqual(shared_rules.write("page", ["ok"])["page"], ["ok"])
        finally:
            if saved is None:
                p.unlink(missing_ok=True)
            else:
                p.write_text(saved)

if __name__ == "__main__":
    unittest.main()
