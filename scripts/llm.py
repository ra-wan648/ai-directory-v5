import requests
import json
import re
import os
from config import load_env

load_env()

MANIFEST_URL = os.environ['MANIFEST_BASE_URL']
API_KEY = os.environ['MANIFEST_API_KEY']


def call_llm(prompt, use_web_search=False, max_tokens=2000):
    body = {
        "model": "auto",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }
    if use_web_search:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]
    try:
        r = requests.post(
            f"{MANIFEST_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}",
                     "Content-Type": "application/json"},
            json=body, timeout=60
        )
        r.raise_for_status()
        data = r.json()
        content = data['choices'][0]['message'].get('content', '')
        if isinstance(content, list):
            return ' '.join(b.get('text', '') for b in content if b.get('type') == 'text')
        return content
    except Exception as e:
        print(f"[ERROR] LLM failed: {e}")
        return None


def extract_json(text, array=False):
    if not text:
        return None
    try:
        pattern = r'\[.*\]' if array else r'\{.*\}'
        match = re.search(pattern, text, re.DOTALL)
        if match:
            return json.loads(match.group())
    except Exception:
        pass
    return None


def parse_tool_from_raw(raw):
    prompt = f"""You are an AI tools directory curator.
Research this tool and return structured data.

Name: {raw.get('name', '')}
URL: {raw.get('url', '')}
Description: {raw.get('raw_desc', '')}

Search the web for current info about this tool.
Return ONLY valid JSON, no markdown:
{{
  "name": "official name",
  "slug": "lowercase-hyphen-slug",
  "description": "150-200 word SEO description",
  "short_desc": "one sentence under 100 chars",
  "category": "Writing|Coding|Image|Video|Marketing|Productivity|Research|Audio|Chat|Business|Automation|Analytics",
  "pricing": "free|freemium|paid",
  "url": "https://official-url.com",
  "tags": "tag1,tag2,tag3,tag4"
}}
If tool info cannot be verified: {{"skip": true}}"""
    result = call_llm(prompt, use_web_search=True)
    data = extract_json(result)
    if not data or data.get('skip'):
        return None
    if raw.get('votes'):
        data['votes'] = raw['votes']
    return data


def generate_blog_from_news(item):
    prompt = f"""Rewrite this AI news as an SEO and AEO optimized blog post.

Title: {item['title']}
URL: {item['url']}
Summary: {item['summary']}
Source: {item['source']}

Requirements:
- 600-900 words
- H2 and H3 headings
- AEO: clear Q&A format, fact-based, citable
- Include 5-question FAQ section
- Do NOT copy original text

Return ONLY valid JSON:
{{
  "title": "SEO title with keyword",
  "slug": "url-slug",
  "content": "<full HTML with h2/h3/p/ul>",
  "meta_description": "max 155 chars",
  "focus_keyword": "primary keyword",
  "category": "review|tutorial|news",
  "faq_schema": [
    {{"q": "Question?", "a": "Answer."}},
    {{"q": "Question?", "a": "Answer."}},
    {{"q": "Question?", "a": "Answer."}},
    {{"q": "Question?", "a": "Answer."}},
    {{"q": "Question?", "a": "Answer."}}
  ]
}}"""
    result = call_llm(prompt, max_tokens=3000)
    return extract_json(result)


def llm_find_new_tools():
    prompt = """Search the web RIGHT NOW for 5 brand new AI tools
launched in the last 48 hours on producthunt.com,
toolify.ai, futurepedia.io, or theresanaiforthat.com.

Avoid well-known tools like ChatGPT or Midjourney.

Return ONLY a valid JSON array:
[
  {
    "name": "Tool Name",
    "slug": "tool-name",
    "description": "150-200 word SEO description",
    "short_desc": "one sentence under 100 chars",
    "category": "Writing|Coding|Image|Video|Marketing|Productivity|Research|Audio|Chat|Business|Automation|Analytics",
    "pricing": "free|freemium|paid",
    "url": "https://...",
    "tags": "tag1,tag2,tag3"
  }
]"""
    result = call_llm(prompt, use_web_search=True, max_tokens=3000)
    return extract_json(result, array=True) or []


def generate_prompt_ideas():
    prompt = """Create 3 creative AI prompts for image generation and text tasks.

Return ONLY valid JSON array:
[
  {
    "title": "Prompt title",
    "slug": "prompt-title-slug",
    "prompt_text": "full copyable prompt text",
    "description": "what this prompt creates, 1-2 sentences",
    "category": "image|text|code|video",
    "compatible_tools": "midjourney,dalle,stable-diffusion"
  }
]"""
    result = call_llm(prompt, max_tokens=2000)
    return extract_json(result, array=True) or []


if __name__ == "__main__":
    print(json.dumps(generate_prompt_ideas(), indent=2))
