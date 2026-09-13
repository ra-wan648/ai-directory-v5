#!/usr/bin/env python3
"""
Regression tests for the tool-vs-news classifier in fresh_data_pipeline.py.

No D1 access, no network - safe to run when the D1 read quota is exhausted.

  python3 scripts/test_classification.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fresh_data_pipeline import (  # noqa: E402
    is_real_tool_url,
    looks_like_tool_text,
    looks_like_news_title,
)

FAILURES = []
CHECKS = 0


def check(label, got, want):
    global CHECKS
    CHECKS += 1
    if got != want:
        FAILURES.append(f"{label}: got {got!r}, want {want!r}")
        print(f"  FAIL  {label}  (got {got!r}, want {want!r})")
    else:
        print(f"  ok    {label}")


print("\n[1] is_real_tool_url - the three rows that were live on the homepage 2026-09-12")
check("reuters.com article", is_real_tool_url(
    "https://www.reuters.com/world/middle-east/uae-revises-ai-data-center-plan-2026-09-12/"), False)
check("theguardian.com article", is_real_tool_url(
    "https://www.theguardian.com/education/2026/sep/12/ai-computer-science-graduates"), False)
check("luma.com event page", is_real_tool_url("https://luma.com/sm9c2mlo"), False)

print("\n[2] is_real_tool_url - must still accept genuine tools")
check("bika.ai", is_real_tool_url("https://bika.ai"), True)
check("hugo.ai", is_real_tool_url("https://hugo.ai/en"), True)
check("pit.com", is_real_tool_url("https://pit.com"), True)
check("x.ai (explicit allow)", is_real_tool_url("https://x.ai"), True)
check("openai.com (explicit allow)", is_real_tool_url("https://openai.com"), True)
check("github repo", is_real_tool_url("https://github.com/acme/cool-tool"), True)

print("\n[3] host-boundary matching - short domains must not match by substring")
check("box.com is NOT blocked by 'x.com'", is_real_tool_url("https://box.com"), True)
check("myreuters.com is NOT blocked by 'reuters.com'",
      is_real_tool_url("https://myreuters.com"), True)
check("subdomain news.reuters.com IS blocked",
      is_real_tool_url("https://news.reuters.com/x"), False)
check("port/userinfo stripped", is_real_tool_url("https://user@www.reuters.com:443/x"), False)

print("\n[4] looks_like_tool_text - word boundaries, not substrings")
check("'apprenticeships' must not count as 'app'", looks_like_tool_text(
    "ai may be denting computer science graduates' job prospects, uk data shows, "
    "with apprenticeships and applications falling"), False)
check("real tool vocabulary", looks_like_tool_text(
    "show hn: i built an ai tool that generates product images"), True)
check("'api' as a whole word", looks_like_tool_text("a fast api for embeddings"), True)

print("\n[5] looks_like_news_title - headline detection")
check("reuters headline",
      looks_like_news_title("UAE revises 5GW AI data center plan after Iranian attacks, sources say"), True)
check("real tool name", looks_like_news_title("bika.ai"), False)
check("real tool name 2", looks_like_news_title("Hugo AI"), False)
check("over-long title", looks_like_news_title("x" * 120), True)

print("\n[6] end-to-end routing of the six live homepage rows")
LIVE_ROWS = [
    ("UAE revises 5GW AI data center plan after Iranian attacks, sources say",
     "https://www.reuters.com/world/middle-east/uae-revises-ai-data-center-plan/", False),
    ("AI may be denting computer science graduates' job prospects, UK data shows",
     "https://www.theguardian.com/education/2026/sep/12/ai-computer-science-graduates", False),
    ("Get tickets", "https://luma.com/sm9c2mlo", False),
    ("bika.ai", "https://bika.ai", True),
    ("hugo.ai", "https://hugo.ai/en", True),
    ("pit.com", "https://pit.com", True),
]
for name, url, should_be_tool in LIVE_ROWS:
    verdict = is_real_tool_url(url) and not looks_like_news_title(name)
    check(f"{name[:48]!r} -> tool? {should_be_tool}", verdict, should_be_tool)

print(f"\n{'=' * 60}")
if FAILURES:
    print(f"FAILED: {len(FAILURES)} of {CHECKS} checks")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print(f"PASSED: all {CHECKS} checks")


# ── Keyword relevance filter ────────────────────────────────────────────────
# HN_KEYWORDS starts with 'ai' and the scrapers used a bare substring test, so
# the filter matched "said", "email", "again" and "storage". These cases pin the
# whole-word behaviour.
print("\n[7] matches_keywords - whole words, not substrings")

from validate import matches_keywords  # noqa: E402

KEYWORDS = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt',
            'claude', 'chatbot', 'agent', 'generative', 'prompt', 'neural',
            'diffusion', 'nlp', 'computer vision', 'speech', 'translation',
            'automation', 'coding', 'text-to-image', 'stable diffusion',
            'rag', 'embedding']

NOT_AI = [
    "Local council approves new parking rules for the town centre",
    "The company said it will email the report again",
    "A study of chair design through the ages",
    "Storage units available for rent in Leeds",
    "RAGBRAI bicycle ride draws 20,000 riders across Iowa",
    "The html and css were minified before the release",
]
for t in NOT_AI:
    check(f"not AI: {t[:44]!r}", matches_keywords(t, KEYWORDS), False)

IS_AI = [
    "A new AI agent for writing code",
    "Show HN: an LLM gateway with prompt caching",
    "We use rag pipelines and embedding search",
    "Agents that automate browser workflows",
    "Text-to-image generation with stable diffusion",
]
for t in IS_AI:
    check(f"is AI: {t[:44]!r}", matches_keywords(t, KEYWORDS), True)


# ── Final verdict ───────────────────────────────────────────────────────────
# The summary block further up runs before the keyword section was added, so a
# failure there would print FAIL and still exit 0. Re-check at the very end.
print("\n" + "=" * 60)
if FAILURES:
    print(f"FAILED: {len(FAILURES)} check(s) across all sections")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print(f"ALL SECTIONS PASSED ({CHECKS} checks)")
