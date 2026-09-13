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

# ─────────────────────────────────────────────
# Host rules — the single source of truth
# ─────────────────────────────────────────────
# A name-only check cannot catch a news article whose headline looks like a
# plausible product name: "UAE revises 5GW AI data center plan after Iranian
# attacks, sources say" is 70 characters and 12 words, so it passed. The host is
# the reliable signal, so the rule lives here and both the scrapers and
# cleanup_junk.py read it from this one place.
#
# Matched on host boundaries (exact host or subdomain), never as a bare
# substring — a substring check for 'x.com' would also reject box.com.
NEWS_HOSTS = (
    'news.ycombinator.com', 'bensbites.com', 'tldr.tech', 'therundown.ai',
    'arxiv.org', 'nature.com', 'bloomberg.com', 'techcrunch.com',
    'youtube.com', 'davidepiffer.com', 'netflixtechblog.com', 'lists.debian.org',
    'cnn.com', 'bbc.com', 'bbc.co.uk', 'wired.com', 'theverge.com', 'medium.com',
    # Wire services and newspapers
    'reuters.com', 'theguardian.com', 'guardian.co.uk', 'apnews.com', 'nytimes.com',
    'washingtonpost.com', 'forbes.com', 'cnbc.com', 'ft.com', 'wsj.com',
    'economist.com', 'businessinsider.com', 'engadget.com', 'arstechnica.com',
    'zdnet.com', 'cnet.com', 'gizmodo.com', 'mashable.com', 'venturebeat.com',
    'thenextweb.com', 'theregister.com', 'axios.com', 'theinformation.com',
    'newsweek.com', 'time.com', 'fortune.com', 'usatoday.com', 'nbcnews.com',
    'abcnews.go.com', 'cbsnews.com', 'aljazeera.com', 'dw.com', 'scmp.com',
    'indiatimes.com', 'timesofindia.com', 'thehindu.com', 'livemint.com',
    'siliconangle.com', 'tomshardware.com', 'infoq.com', 'sdtimes.com',
    'qz.com', 'vice.com', 'semafor.com', 'theatlantic.com', 'politico.com',
    'news.google.com', 'apple.news', 'flipboard.com', 'yahoo.com', 'msn.com',
    # Personal publishing platforms publish articles, not products.
    'substack.com', 'ghost.io', 'wordpress.com', 'blogspot.com', 'notion.site',
    # Event, ticketing and hackathon pages are not tools.
    'luma.com', 'lu.ma', 'eventbrite.com', 'meetup.com', 'ticketmaster.com',
    'devpost.com', 'hopin.com', 'airmeet.com',
    # Social, aggregators and discussion sites.
    'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'linkedin.com',
    'instagram.com', 'tiktok.com', 'threads.net', 'hackernews.com',
    'techmeme.com', 'indiehackers.com',
)

# Hosts that must survive the blocklist above.
ALLOWED_TOOL_HOSTS = ('x.ai', 'openai.com')

# Ad networks, redirectors and link shorteners. A row on one of these is never a
# tool: the scrapers picked up ad-click URLs such as
# googleads.g.doubleclick.net/aclk and googleadservices.com/pagead/aclk, and 23
# of them were published with names like "Get Quotes" and "Start Now".
TRACKING_HOSTS = (
    'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
    'adservice.google.com', 'googletagmanager.com', 'google-analytics.com',
    'adnxs.com', 'criteo.com', 'outbrain.com', 'taboola.com', 'shareasale.com',
    'awin1.com', 'clickbank.net', 'bit.ly', 't.co', 'tinyurl.com', 'lnkd.in',
    'rebrand.ly', 'cutt.ly',
)

# Directory and aggregator pages. The tool's own site belongs in url, not the
# listing page that describes it. Kept separate from TRACKING_HOSTS so it gets
# its own reason and can be reviewed on its own: the 479 producthunt.com/r/...
# rows are real products with the wrong URL, not junk, and each one needs its
# real website fetched rather than deleted.
DIRECTORY_HOSTS = (
    'futuretools.io', 'toolify.ai', 'theresanaiforthat.com',
    'futurepedia.io', 'aixploria.com', 'allthingsai.com', 'toolfk.com',
    'insidr.ai', 'topai.tools',
)

# Product Hunt redirect links get their own reason. Reviewed on 13 Sep: of the
# 907 held "directory page" rows, 479 were producthunt.com/r/... - real products
# whose url just needs fetching from Product Hunt - while the other 428 were
# genuine junk such as "View BlitzReels", "Newsletter Archive" and "Merchandise"
# scraped off directory navigation. Hiding them together would have thrown away
# 479 real tools, so the two are now distinguishable.
PRODUCTHUNT_HOSTS = ('producthunt.com',)


def _host_is(host, domain):
    """True when host is exactly `domain` or a subdomain of it."""
    return host == domain or host.endswith('.' + domain)


def host_of(url):
    """Lowercase hostname of a URL, with userinfo and port stripped."""
    s = str(url or '').strip().lower()
    if not s:
        return ''
    if '//' in s:
        s = s.split('//', 1)[1]
    s = s.split('/', 1)[0].split('?', 1)[0]
    s = s.rsplit('@', 1)[-1].split(':', 1)[0]
    return s


def is_news_host(url):
    """True when the URL is not a tool's own site.

    Covers news and event hosts, social and publishing platforms, ad networks,
    link shorteners and directory pages - anything that cannot be a product's
    homepage.
    """
    host = host_of(url)
    if not host:
        return False
    for d in ALLOWED_TOOL_HOSTS:
        if _host_is(host, d):
            return False
    return any(_host_is(host, d) for d in NEWS_HOSTS + TRACKING_HOSTS)


def matches_keywords(text, keywords):
    """Whole-word keyword match.

    The scrapers used `any(kw in text for kw in HN_KEYWORDS)` with 'ai' first in
    the list, so the relevance filter also matched "s(ai)d", "em(ai)l", "ag(ai)n",
    "ch(ai)r" and "av(ai)lable" - and 'ml' matched "html", 'rag' matched
    "storage". In practice it let almost any English text through.

    Short keywords are matched on word boundaries, with an optional plural 's'.
    Multi-word and hyphenated keywords stay plain substrings.
    """
    low = (text or '').lower()
    for kw in keywords:
        k = str(kw).lower().strip()
        if not k:
            continue
        if ' ' in k or '-' in k:
            if k in low:
                return True
        elif re.search(r'(?<![a-z0-9])' + re.escape(k) + r's?(?![a-z0-9])', low):
            return True
    return False


def clean_name(raw):
    """Tidy a scraped name: drop markup, entities and stray separators."""
    name = str(raw or '')
    name = _TAG_RE.sub(' ', name)          # twice: markup can be nested
    name = _TAG_RE.sub(' ', name)
    name = _ENTITY_RE.sub(' ', name)
    name = name.replace('\\', ' ')
    name = re.sub(r'\s+', ' ', name)
    return name.strip(" \t'\"“”‘’;:|,-–—.")


# Scraped navigation and page furniture, not product names. Taken from rows that
# were actually published: "Visit Deepl website", "View PDF", "Best AI Tools
# Directory", "Newsletter Archive", "Merchandise", "Pricing".
_SCRAPED_ARTEFACT_RE = re.compile(
    r"^(visit|view|see|read|open|click|go to)\s+.{0,40}\b(site|website|page|pdf|more|details|link|now)\b"
    r"|^(best|top)\s+[\w\s]{0,24}(ai\s+)?(tools?|director(y|ies))\b"
    r"|^(newsletter|newsletters|merchandise|shop|pricing|plans|terms|privacy|cookies?|contact|about us|blog|login|sign ?up)\b"
    r"|\bdirectory\b$"
)


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
    if _SCRAPED_ARTEFACT_RE.search(low):
        return False, 'scraped artefact'
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


def is_directory_host(url):
    """True when the URL is a listing page on a directory, not the tool's site."""
    host = host_of(url)
    if not host:
        return False
    return any(_host_is(host, d) for d in DIRECTORY_HOSTS)


def is_producthunt_redirect(url):
    """True when the URL is a Product Hunt page rather than the product's site."""
    host = host_of(url)
    if not host:
        return False
    return any(_host_is(host, d) for d in PRODUCTHUNT_HOSTS)


def is_valid_row(name, url=''):
    """Should this row be published? Checks the name AND the host.

    cleanup_junk.py used to look at the name alone, so a news article with a
    headline-shaped name stayed live even though its URL was wsj.com. Returns
    (ok, reason).
    """
    ok, why = is_valid_name(clean_name(name))
    if not ok:
        return False, why
    if is_news_host(url):
        return False, 'news/article host'
    if is_producthunt_redirect(url):
        return False, 'producthunt redirect'
    if is_directory_host(url):
        return False, 'directory page'
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
