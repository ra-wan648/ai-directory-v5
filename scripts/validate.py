"""Name/slug validation shared by both pipeline scripts.

Rows that should never have been published reached the live site, because the
only gates were "not a nav word" and "not purely digits". Actual examples seen
in the table:  ';"> API',  'cloudflare.com',  'mixture-of-experts'.

Keeping the rules in one module means the two scrapers cannot drift apart, and
every rejection carries a reason so the Telegram report can show *why* rows were
dropped instead of quietly losing them.
"""
import re

# Page furniture rather than a product.
NAV_WORDS = {
    'home', 'about', 'contact', 'pricing', 'sign in', 'sign in / sign up',
    'sign up', 'login', 'log out', 'logout', 'privacy', 'terms', 'search',
    'menu', 'more', 'read more', 'read more ', 'newsletter', 'subscribe',
    'categories', 'tags', 'blog', 'faq', 'help', 'jobs', 'careers', 'press',
    'team', 'partners', 'back to top', 'next', 'previous', 'prev', 'loading',
    'ai news', 'news', 'features', 'trending', 'new', 'all categories',
    'submit a tool', 'advertise', 'affiliate', 'cookie policy', 'sitemap',
}

# Characters that mean the "name" is markup or a fragment, not a name.
JUNK_CHARS = set('<>{}[]|=\\"`~^*#@$%')

_URL_RE = re.compile(r'https?://|www\.', re.I)
_DOMAIN_RE = re.compile(r'^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$')

# A bare hostname is only treated as a scraped URL when its TLD is a generic
# one. Rejecting on the dot alone threw away real product names - Copy.ai is a
# product, cloudflare.com is a page address - so the .ai/.io/.dev family is
# allowed through and only the plain web TLDs are refused.
_GENERIC_TLDS = {'com', 'net', 'org', 'gov', 'edu', 'info', 'biz', 'us', 'uk'}
_NO_LETTERS_RE = re.compile(r'^[\d\W_]+$')
_SLUG_OK_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')

# The scrapers sometimes grab a card's title plus its description in one string,
# e.g. "CocoHumanizer Free Free AI humanizer for..." or
# "ModelGenerator AI tool for generating text". Only applied to longer strings,
# so a real name that happens to contain "for" is untouched.
_DESC_CONNECTOR_RE = re.compile(
    r'\b(?:ai )?tools? (?:for|to)\b|\bis an?\b|\b(?:app|platform|service) for\b',
    re.I)
_TAG_RE = re.compile(r'<[^>]*>')
_ENTITY_RE = re.compile(r'&[a-zA-Z]+;|&#\d+;')


def clean_name(raw):
    """Tidy a scraped name: drop markup, entities and stray separators."""
    name = str(raw or '')
    name = _TAG_RE.sub(' ', name)          # twice: markup can be nested
    name = _TAG_RE.sub(' ', name)
    name = _ENTITY_RE.sub(' ', name)
    name = name.replace('\\', ' ')
    name = re.sub(r'\s+', ' ', name)
    return name.strip(" \t'\"“”‘’;:|,-–—.")


def is_valid_name(name):
    """Should this row be published? Returns (ok, reason)."""
    n = (name or '').strip()
    if len(n) < 2:
        return False, 'too short'
    if len(n) > 80:
        return False, 'too long'
    if len(n.split()) > 12:
        return False, 'sentence not a name'
    low = n.lower()
    if low in NAV_WORDS:
        return False, 'nav word'
    if _URL_RE.search(n):
        return False, 'is a url'
    if _DOMAIN_RE.match(n):
        tld = n.rsplit('.', 1)[-1].lower()
        if tld in _GENERIC_TLDS:
            return False, 'is a bare domain'
    if _NO_LETTERS_RE.match(n):
        return False, 'no letters'
    if any(c in JUNK_CHARS for c in n):
        return False, 'contains markup'
    words = [w for w in re.split(r'\W+', low) if w]
    if len(words) >= 2 and len(set(words)) == 1:
        return False, 'repeated word'
    # An immediately repeated word is the scrapers gluing two elements together
    # ("CocoHumanizer Free Free AI humanizer for text"). Real names rarely do it.
    if any(a == b for a, b in zip(words, words[1:])):
        return False, 'duplicated word'
    if len(words) > 5 and _DESC_CONNECTOR_RE.search(n):
        return False, 'name mixed with description'
    return True, ''


def normalize_slug(name, slug=None):
    """Slug derived from the cleaned name, so it always matches what is shown.

    The scraped slug was sometimes taken from a different element than the name
    (page furniture, a concatenated string), which is why rows could carry a
    sensible name with a nonsense slug.
    """
    base = re.sub(r'[^a-z0-9]+', '-', clean_name(name).lower()).strip('-')
    base = base[:80].strip('-')
    if base and _SLUG_OK_RE.match(base):
        return base
    # last resort: keep whatever slug was supplied if it is at least sane
    fallback = re.sub(r'[^a-z0-9]+', '-', str(slug or '').lower()).strip('-')[:80]
    return fallback.strip('-') or base or 'unnamed'


def filter_rows(rows, name_key='name', slug_key='slug'):
    """Clean and validate a batch. Returns (kept, rejection_reasons)."""
    kept, reasons = [], {}
    for row in rows:
        cleaned = clean_name(row.get(name_key))
        ok, why = is_valid_name(cleaned)
        if not ok:
            reasons[why] = reasons.get(why, 0) + 1
            continue
        row = dict(row)
        row[name_key] = cleaned
        row[slug_key] = normalize_slug(cleaned, row.get(slug_key))
        kept.append(row)
    return kept, reasons
