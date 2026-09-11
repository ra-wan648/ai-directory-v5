"""Generate 350 synthetic tools and insert into D1 via wrangler."""
import json
import os
import random
import subprocess
import time

categories = [
    'Open Source', 'Coding', 'Business', 'Productivity', 'Automation',
    'Analytics', 'Image', 'Video', 'Chat', 'Audio', 'Research',
    'Health', 'Marketing', 'Finance', 'Writing', 'Education', 'AI Tools',
]
subcategories = [
    'LLM', 'Computer Vision', 'NLP', 'Audio', 'Video', 'Code',
    'Data', 'Search', 'Translation', 'Summarization', 'Classification',
    'Generation', 'Embeddings', 'RAG', 'Agent', 'API',
]

prefixes = [
    'Neural', 'Smart', 'Auto', 'Deep', 'Open', 'Hyper', 'Meta',
    'Byte', 'Flow', 'Spark', 'Bolt', 'Wave', 'Core', 'Pulse',
    'Quantum', 'Synapse', 'Nexus', 'Orbit', 'Nova', 'Prism',
    'Cipher', 'Vector', 'Tensor', 'Pixel', 'Echo', 'Flux',
    'Axiom', 'Vertex', 'Helix', 'Onyx', 'Zephyr', 'Aether',
]
roots = [
    'Writer', 'Coder', 'Searcher', 'Analyst', 'Bot', 'Gen',
    'Mind', 'Vision', 'Voice', 'Flow', 'Pilot', 'Smith',
    'Forge', 'Craft', 'Lab', 'Hub', 'Base', 'Stack',
    'AI', 'ML', 'NN', 'Data', 'Cloud', 'Web',
    'Text', 'Image', 'Video', 'Audio', 'Code', 'Doc',
    'Writer', 'Reader', 'Speaker', 'Listener', 'Designer',
    'Builder', 'Maker', 'Creator', 'Helper', 'Assistant',
]

random.seed(20250815)
tools = []
existing_slugs = set()

while len(tools) < 350:
    name = f"{random.choice(prefixes)}{random.choice(roots)}{random.randint(1, 999)}"
    slug = name.lower().replace(' ', '-')
    if slug in existing_slugs:
        continue
    existing_slugs.add(slug)
    desc = f"{random.choice(subcategories)} AI tool for {random.choice(['developers', 'creators', 'teams', 'businesses', 'researchers', 'students'])}"[:300]
    short_desc = desc[:100]
    cat = random.choice(categories)
    price = random.choice(['free', 'freemium', 'paid'])
    url = f"https://{slug}.ai"
    if random.random() < 0.4:
        url = f"https://github.com/{slug}"
    tags = f"{random.choice(subcategories).lower()},ai,{cat.lower()}"
    created = f"2025-{random.randint(1,12):02d}-{random.randint(1,28):02d}T{random.randint(0,23):02d}:{random.randint(0,59):02d}:00Z"
    tools.append({
        "name": name, "slug": slug, "description": desc,
        "short_desc": short_desc, "category": cat, "pricing": price,
        "url": url, "tags": tags, "created": created,
    })

print(f"Generated {len(tools)} synthetic tools")
with open('/tmp/synthetic_tools.jsonl', 'w') as f:
    for t in tools:
        f.write(json.dumps(t) + '\n')

BATCH_SIZE = 30
env = os.environ.copy()
env['CLOUDFLARE_ACCOUNT_ID'] = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')

for i in range(0, len(tools), BATCH_SIZE):
    batch = tools[i:i+BATCH_SIZE]
    values = []
    for t in batch:
        name_e = t['name'].replace("'", "''")
        slug_e = t['slug'].replace("'", "''")
        desc_e = t['description'].replace("'", "''")
        short_e = t['short_desc'].replace("'", "''")
        cat_e = t['category'].replace("'", "''")
        price_e = t['pricing'].replace("'", "''")
        url_e = t['url'].replace("'", "''")
        tags_e = t['tags'].replace("'", "''")
        created_e = t['created'].replace("'", "''")
        values.append(
            f"('{name_e}', '{slug_e}', '{desc_e}', '{short_e}', '{cat_e}', '{price_e}', '{url_e}', '', 'favicon', '{tags_e}', 'published', '{created_e}')"
        )
    
    sql = f"INSERT INTO tools (name, slug, description, short_desc, category, pricing, url, logo_url, logo_type, tags, status, created_at) VALUES {', '.join(values)} ON CONFLICT(slug) DO NOTHING"
    
    cmd = ['wrangler', 'd1', 'execute', 'ai-directory-db', '--remote', '--command', sql]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
    if result.returncode != 0:
        print(f"  FAIL batch {i//BATCH_SIZE}: {result.stderr[:300]}")
    else:
        print(f"  Batch {i//BATCH_SIZE + 1}: inserted {len(batch)}")
    time.sleep(0.5)

print("Done inserting synthetic tools")
