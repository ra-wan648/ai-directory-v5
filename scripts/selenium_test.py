"""Test each blocked site with undetected-chromedriver and scrape accessible ones."""
import time
import json
import os
import random
import subprocess
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

CHROME_PATH = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
CHROMEDRIVER_PATH = "/tmp/chromedriver_extracted/chromedriver-linux64/chromedriver"

SITES = [
    ("toolify", "https://www.toolify.ai/"),
    ("futurepedia", "https://www.futurepedia.io/ai-tools"),
    ("theresanaiforthat", "https://theresanaiforthat.com/"),
    ("allthingsai", "https://allthingsai.com/"),
    ("futuretools", "https://www.futuretools.io/"),
    ("topai", "https://topai.tools/"),
    ("aixploria", "https://www.aixploria.com/en/"),
    ("insidr", "https://www.insidr.ai/ai-tools/"),
    ("toolfk", "https://www.toolfk.com/"),
    ("trendshift", "https://trendshift.io/repositories"),
]

PAGE_SELECTORS = {
    "toolify": ["a[href*='/ai-tool']", "article", "div[class*='card']", "div[class*='tool']"],
    "futurepedia": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "theresanaiforthat": ["a[href*='/ai/']", "article", "div[class*='card']", "div[class*='tool']"],
    "allthingsai": ["a[href*='/tools/']", "article", "div[class*='card']", "div[class*='tool']"],
    "futuretools": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "topai": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "aixploria": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "insidr": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "toolfk": ["a[href*='/tool/']", "article", "div[class*='card']", "div[class*='tool']"],
    "trendshift": ["a[href*='/repository/']", "article", "div[class*='card']", "div[class*='repo']"],
}

def make_driver():
    opts = Options()
    opts.binary_location = CHROME_PATH
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1920,1080")
    opts.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    opts.add_argument("--headless=new")
    service = webdriver.ChromeService(executable_path=CHROMEDRIVER_PATH)
    driver = webdriver.Chrome(service=service, options=opts)
    return driver

def is_blocked(driver, url):
    """Check if page is blocked by bot detection."""
    try:
        source = driver.page_source.lower()
        blocks = ['just a moment', 'checking your browser', 'blocked', 'security check', 
                  'captcha', 'access denied', 'perimiter', 'ddos', 'attention required',
                  'please wait', 'too many requests', 'rate limit']
        if any(b in source for b in blocks):
            return True
        title = driver.title.lower()
        if any(b in title for b in ['just a moment', 'checking', 'blocked', 'security']):
            return True
        return False
    except:
        return True

def scrape_page(driver, site_name, url):
    """Extract tool data from a page."""
    selectors = PAGE_SELECTORS.get(site_name, ["a[href]"])
    time.sleep(random.uniform(3, 5))
    
    # Check for bot detection
    if is_blocked(driver, url):
        return [], "blocked"
    
    tools = []
    seen_slugs = set()
    
    # Try each selector
    for sel in selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, sel)
            for el in elements[:50]:
                try:
                    href = el.get_attribute('href') or ''
                    text = el.text.strip()
                    if not text or len(text) < 5:
                        continue
                    
                    # Skip non-tool links
                    if not any(p in href for p in ['/tool/', '/ai/', '/repository/', '/product/', '/app/']):
                        if '/tool' in sel or '/ai' in sel or '/repository' in sel:
                            continue
                    
                    # Clean name
                    name = text.split('\n')[0].strip()[:150]
                    if not name or len(name) < 3:
                        continue
                    
                    slug = name.lower().replace(' ', '-')[:80]
                    if slug in seen_slugs or len(slug) < 3:
                        continue
                    seen_slugs.add(slug)
                    
                    # Try to get description
                    desc = ""
                    for parent_level in range(4):
                        try:
                            parent = el
                            for _ in range(parent_level + 1):
                                parent = parent.find_element(By.XPATH, "./parent::*")
                            descs = parent.find_elements(By.CSS_SELECTOR, "p, .description, [class*='desc'], [class*='summary']")
                            if descs:
                                desc = descs[0].text.strip()[:300]
                                break
                        except:
                            continue
                    
                    # Extract category from URL path
                    cat = "Uncategorized"
                    if '/tool/' in href:
                        cat = href.split('/tool/')[1].split('/')[0].replace('-', ' ').title()
                    elif '/ai/' in href:
                        cat = href.split('/ai/')[1].split('/')[0].replace('-', ' ').title()
                    elif '/repository/' in href:
                        cat = "Open Source"
                    
                    tools.append({
                        "name": name,
                        "slug": slug,
                        "description": desc or name,
                        "category": cat,
                        "price": "unknown",
                        "url": href[:200] if href else "",
                        "site": site_name,
                    })
                except:
                    continue
            if tools:
                break
        except Exception as e:
            continue
    
    # If no tools found with selectors, try all links on page
    if not tools:
        try:
            all_links = driver.find_elements(By.TAG_NAME, "a")
            for link in all_links[:100]:
                try:
                    href = link.get_attribute('href') or ''
                    text = link.text.strip()
                    if not text or len(text) < 8:
                        continue
                    if not any(p in href for p in ['/tool/', '/ai/', '/repository/', '/product/', '/app/']):
                        continue
                    
                    name = text[:150]
                    slug = name.lower().replace(' ', '-')[:80]
                    if slug in seen_slugs or len(slug) < 3:
                        continue
                    seen_slugs.add(slug)
                    
                    cat = "Uncategorized"
                    if '/repository/' in href:
                        cat = "Open Source"
                    
                    tools.append({
                        "name": name,
                        "slug": slug,
                        "description": name,
                        "category": cat,
                        "price": "unknown",
                        "url": href[:200],
                        "site": site_name,
                    })
                except:
                    continue
        except:
            pass
    
    status = "scraped" if tools else "no_cards"
    return tools, status

print("=" * 70)
print("Selenium + ChromeDriver 151 site test")
print("=" * 70)

results = []
all_tools = []

for site_name, url in SITES:
    print(f"\n--- {site_name}: {url} ---")
    driver = None
    try:
        driver = make_driver()
        driver.get(url)
        tools, status = scrape_page(driver, site_name, url)
        accessible = "yes" if status in ("scraped", "no_cards") else "no"
        tools_visible = "yes" if status == "scraped" else "no"
        print(f"  Status: {status} | Accessible: {accessible} | Tools visible: {tools_visible}")
        print(f"  Found {len(tools)} tools")
        
        results.append({
            "site": site_name,
            "url": url,
            "status": status,
            "accessible": accessible,
            "tools_visible": tools_visible,
            "count": len(tools),
        })
        
        if status == "scraped" and tools:
            all_tools.extend(tools)
            print(f"  Sample: {[t['name'] for t in tools[:5]]}")
            
            # Try to scrape 2 more pages
            for page_num in range(2):
                try:
                    # Look for pagination
                    next_links = driver.find_elements(By.CSS_SELECTOR, "a[href*='page'], a[href*='offset'], a[href*='?page'], button[aria-label*='next']")
                    next_url = None
                    for link in next_links:
                        href = link.get_attribute('href')
                        if href and page_num == 0:
                            # Try to find page 2 URL
                            if '/page/2' in href or '?page=2' in href or '&page=2' in href:
                                next_url = href
                                break
                            # Try common patterns
                            for pattern in ['/page/2', '?page=2', '&page=2']:
                                if pattern in url:
                                    next_url = url.replace(pattern.split('=')[0]+'='+pattern.split('=')[1].split('&')[0], pattern.split('=')[1].split('&')[0])
                                    break
                            if not next_url:
                                next_url = url.rstrip('/') + '/page/2'
                                # Check if it's a valid page
                                try:
                                    new_driver = make_driver()
                                    new_driver.get(next_url)
                                    if is_blocked(new_driver, next_url):
                                        new_driver.quit()
                                        next_url = None
                                    else:
                                        new_driver.quit()
                                except:
                                    next_url = None
                    
                    if next_url:
                        driver.get(next_url)
                        extra, _ = scrape_page(driver, site_name, next_url)
                        if extra:
                            all_tools.extend(extra)
                            print(f"  Page {page_num+2}: +{len(extra)} tools")
                        else:
                            break
                    else:
                        break
                except Exception as e:
                    break
            time.sleep(random.uniform(2, 4))
            
    except Exception as e:
        print(f"  Error: {e}")
        results.append({"site": site_name, "url": url, "status": f"error:{str(e)[:50]}", "accessible": "no", "tools_visible": "no", "count": 0})
    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass
        time.sleep(random.uniform(2, 3))

print("\n" + "=" * 70)
print("RESULTS SUMMARY")
print("=" * 70)
print(f"{'Site':<20} {'Accessible':<12} {'Tools Visible':<15} {'Count':<8} {'Status'}")
print("-" * 70)
for r in results:
    print(f"{r['site']:<20} {r['accessible']:<12} {r['tools_visible']:<15} {r['count']:<8} {r['status']}")

print(f"\nTotal real tools found: {len(all_tools)}")

# Save results
with open('/tmp/selenium_results.json', 'w') as f:
    json.dump(results, f, indent=2)
with open('/tmp/selenium_tools.json', 'w') as f:
    json.dump(all_tools, f, indent=2)

# Deduplicate
from collections import OrderedDict
seen = OrderedDict()
for t in all_tools:
    key = t['slug']
    if key not in seen:
        seen[key] = t

unique_tools = list(seen.values())
print(f"After dedup: {len(unique_tools)} unique tools")

# Insert into D1
env = os.environ.copy()
env['CF_API_TOKEN'] = os.environ.get('CF_API_TOKEN', '')
env['CLOUDFLARE_ACCOUNT_ID'] = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')

BATCH_SIZE = 30
for i in range(0, len(unique_tools), BATCH_SIZE):
    batch = unique_tools[i:i+BATCH_SIZE]
    values = []
    for t in batch:
        name_e = t['name'].replace("'", "''")
        slug_e = t['slug'].replace("'", "''")
        desc_e = t['description'].replace("'", "''")
        short_e = t['description'][:100].replace("'", "''")
        cat_e = t['category'].replace("'", "''")
        price_e = t.get('price', 'free').replace("'", "''")
        url_e = t.get('url', '').replace("'", "''")
        tags_e = f"{t['category'].lower()},{t['site']}"
        created = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        values.append(f"('{name_e}', '{slug_e}', '{desc_e}', '{short_e}', '{cat_e}', '{price_e}', '{url_e}', '', 'favicon', '{tags_e}', 'published', '{created}')")
    
    sql = f"INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES {', '.join(values)} ON CONFLICT(slug) DO NOTHING"
    
    cmd = ['wrangler', 'd1', 'execute', 'ai-directory-db', '--remote', '--command', sql]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    if result.returncode != 0:
        print(f"  FAIL batch {i//BATCH_SIZE}: {result.stderr[:200]}")
    else:
        print(f"  Batch {i//BATCH_SIZE + 1}: inserted {len(batch)}")
    time.sleep(0.5)

print("\nDone!")
