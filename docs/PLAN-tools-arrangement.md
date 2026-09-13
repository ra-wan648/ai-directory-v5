# টুল সাজানোর প্ল্যান — beyondtools.io মডেল ধরে

তারিখ: ১৩ সেপ্টেম্বর, ২০২৬ · সাইট: https://ai-directory-v5-radwan648.pages.dev

---

## ১. রেফারেন্স সাইট কীভাবে সাজায় (beyondtools.io)

রেন্ডার করে দেখেছি (JS-rendered সাইট, তাই curl দিয়ে শুধু শেল আসে — render করে পড়া হয়েছে)।

**হোমপেজের ক্রম:**

| # | সেকশন | কাজ |
|---|---|---|
| ১ | Hero — "5000+ AI Tools Ranked by Community" | বড় সংখ্যা + পজিশনিং ("community ranked") |
| ২ | Best AI Tools Directory (এক লাইনের প্রস্তাবনা) | পরিষ্কার ভ্যালু-প্রপোজিশন |
| ৩ | **Popular AI Tools** | community-voted সেরা টুলের গ্রিড |
| ৪ | **Browse AI Tools** | ক্যাটাগরি কার্ডের গ্রিড (কাজ অনুযায়ী ভাগ) |
| ৫ | "Marketplace That Pays You Back" | reward/engagement ব্লক |
| ৬ | **Happening in AI World** | নিউজ/ব্লগ |

**`/tools` পেজটাই তাদের মূল পণ্য** — সাইটটা আসলে এই একটা পেজকে ঘিরে:

```
Search  ·  Filter  ·  Discover
All Categories ▾        All Prices ▾
  AI Assistants & Agents · Writing & Content Creation · Design, Art & Creativity ·
  Video & Animation · Voice, Sound & Music · Coding & Development ·
  Business & Productivity · Finance & Trading · Health & Wellness ·
  Education & Learning · Everyday & Lifestyle · Other / Experimental
  All Prices · 💚 Free · 🔵 Freemium · 💰 Paid
"Latest 0 approved AI tools"            ← লাইভ কাউন্ট
🛠️ Recent AI Tools                       ← কার্ড গ্রিড
Page 1 of 1                              ← পেজিনেশন
"Can't find what you're looking for?" → Submit New Tool
```

**শিক্ষণীয় তিনটা জিনিস:**
1. **একটা browse পেজ যেখানে সব ফিল্টার একসাথে** — হোমপেজের সেকশনগুলো শুধু প্রবেশপথ।
2. **ক্যাটাগরিগুলো কাজ/উদ্দেশ্য অনুযায়ী** ("Video & Animation", "Finance & Trading") — প্রযুক্তি অনুযায়ী নয়।
3. **Pricing ফিল্টার সবার উপরে** — Free/Freemium/Paid; মানুষ প্রথমেই এটা দেখে।

---

## ২. আমরা এখন কোথায়

### আছে (শক্ত ভিত্তি)
- `/api/tools` — **১১টা ফিল্টার**: `category, pricing, source, tag, featured, days, q, sort, page, limit, slugs` + `compatible_tools`
- `/tool/<slug>` (SSR), `/category/<slug>` (SSR), `/tag/<slug>`, `/alternatives/<slug>`, `/compare/:a/:b`, `/post/<slug>`, `/blog`, `/prompts`, `sitemap.xml` (১৬,০৯৩ URL)
- হোমপেজে ৬টা সেকশন, সার্চ, ক্যাটাগরি কার্ড
- **স্ট্যাটিক fallback** — `public/data/offline.json` + `sections.json` (আজ যোগ করা; D1 কোটা শেষ হলেও সাইট ফাঁকা হবে না)

### নেই / দুর্বল (মাপা)

| সমস্যা | মাপ |
|---|---|
| **unified browse পেজ নেই** | `/tools`, `/browse`, `/list` — সব **৪০৪** |
| **ক্যাটাগরি taxonomy দুর্বল** | `AI Tools` ক্যাচ-অলে **৩,৭৬৯টা** = পুরোটার **৪৮%** |
| **ক্যাটাগরি টেবিল অসম্পূর্ণ** | tools-এ ১৯টা distinct ক্যাটাগরি, কিন্তু `categories` টেবিলে **১২টা** ⇒ ৭টার কোনো পেজ/লিংক নেই |
| সেকশন ফাঁকা | হোমপেজের ৫/৬ সেকশন (কারণ D1 কোটা, নিচে দেখুন) |
| "Browse by Category" অসম্পূর্ণ | স্ক্রিনে মাত্র ৪টা দেখায় |
| "Latest News" কার্ড খালি | টাইটেল/ছবি আসে না, শুধু `NEWS` placeholder |
| নাম-ফিল্টার দুর্বল | `Visit Deepl website`, `Raspberry Pi`, `CrazyGames Poki` পাবলিশড |
| হার্ডকোড আউটবাউন্ড | `toolfk.com` — আমাদের সাইট থেকে তৃতীয় পক্ষে |

### সেকশন ফাঁকা হওয়ার আসল কারণ (অনুমান নয়, মাপা)

```
D1 rows read  : 7,739,381 / দিন
D1 free limit : 5,000,000 / দিন
```

সাইটের **প্রতিটা read** D1-এ যায় (এটা একটা ক্লায়েন্ট-সাইড ডেটা লেয়ার)। কোটা শেষ = সব ফাঁকা।
মূল খরচ ছিল `ORDER BY views DESC`-এ ইনডেক্স না থাকা (প্রতি টুল পেজে ~৮,৬০০ read) — ইনডেক্সটা
আজ তৈরি হয়েছে, আর স্ট্যাটিক fallback বসানো হয়েছে। **০২:০০ UTC-র নাইটলিতে বাকিটা স্বয়ংক্রিয়।**

---

## ৩. টার্গেট কাঠামো

### ৩.১ `/tools` — নতুন browse পেজ (সবচেয়ে বড় কাজ)

```
┌ AI Tools Directory ────────────────────────────────── ৭,৮১২ টুল
│ [🔍 Search ..................................]  [Sort ▾]
│ Category: [All] [Assistants] [Writing] [Design] [Video] [Audio]
│           [Coding] [Business] [Finance] [Health] [Education] [Other]
│ Price:    [All] [Free] [Freemium] [Paid]     Source: [All ▾]
│ ─────────────────────────────────────────────────────────────
│ "৭,৮১২টি টুল · ফিল্টার: Free · page 1/79"
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      ← ৪ কলাম (ডেস্কটপ)
│ │ card │ │ card │ │ card │ │ card │         ২ কলাম (মোবাইল)
│ └──────┘ └──────┘ └──────┘ └──────┘
│ ... প্রতি পেজে ৪০টা
│ [← আগের]  Page 1 of 79  [পরের →]
│ "টুল খুঁজে পেলেন না?" → Submit a tool
└──────────────────────────────────────────────────────
```

**বাস্তবায়ন:** নতুন `functions/tools/index.js` (SSR), যা `/api/tools?...` পড়ে HTML রেন্ডার করে।
ফিল্টার state URL-এ (`/tools?category=Coding&pricing=free&page=2`) ⇒ শেয়ার/বুকমার্ক/SEO-যোগ্য।
**নতুন কোনো ব্যাকএন্ড লাগবে না** — `/api/tools` আগেই সব ফিল্টার সাপোর্ট করে।

### ৩.২ টুল কার্ডের অ্যানাটমি (সব জায়গায় একই)

```
┌────────────────────────────────────────┐
│ [logo 32px] Name            [💚 Free]  │  ← নাম + pricing ব্যাজ
│             Category · Source          │  ← মেটা লাইন
│ এক লাইনের বর্ণনা (short_desc)           │  ← ২ লাইনে clamp
│ [Visit →]        [Alternatives] [⚖]    │  ← CTA + সম্পর্কিত
└────────────────────────────────────────┘
```
- `logo_url` না থাকলে ডোমেইনের favicon (`google.com/s2/favicons?domain=`) — স্ক্রিনে এখন খালি বক্স দেখাচ্ছে
- pricing ব্যাজের রঙ একরকম সব জায়গায়
- কার্ডের পুরোটা ক্লিকযোগ্য (modal), পাশে `Visit` বাইরের লিংক

### ৩.৩ হোমপেজের নতুন ক্রম (রেফারেন্স ধরে, আমাদের ডেটা দিয়ে)

| # | সেকশন | ডেটা |
|---|---|---|
| ১ | Hero — "৭,৮১২ AI tools, দৈনিক আপডেট" | `/api/stats` |
| ২ | **Browse by Category** (১২টা কার্ড, icon + সংখ্যা) | `/api/categories` |
| ৩ | 🆕 New This Week | `sort=newest&days=7` |
| ৪ | 💚 Free Tools | `pricing=free` |
| ৫ | 🔥 Trending | `/api/tools/trending` |
| ৬ | 📂 Open Source | `category=Open Source` |
| ৭ | 🌟 Featured | `featured=1` |
| ৮ | 📰 Latest News | `/api/news` |
| ৯ | CTA — Submit a tool + Telegram | স্থির |

পরিবর্তন: **ক্যাটাগরি সেকশনটা একেবারে উপরে** (রেফারেন্সের #4 আগে বসানো) — মানুষ আগে "কী কাজের টুল" দেখতে চায়, তারপর "নতুন কী"।

### ৩.৪ ক্যাটাগরি taxonomy — নতুন ম্যাপিং

সবচেয়ে বড় ডেটা-সমস্যা: **৩,৭৬৯টা টুল (৪৮%) "AI Tools" নামের ক্যাচ-অলে**। রেফারেন্সের উদ্দেশ্যভিত্তিক
গ্রুপিং ধরে ম্যাপিং প্রস্তাব:

| এখন | নতুন গ্রুপ |
|---|---|
| AI Tools, AI Assistant, Chat | **Assistants & Agents** |
| Writing | **Writing & Content** |
| Image | **Design & Art** |
| Video | **Video & Animation** |
| Audio | **Voice & Sound** |
| Coding, Open Source | **Coding & Dev** |
| Business, Productivity, Marketing | **Business & Productivity** |
| Finance | **Finance** |
| Education, Research | **Education & Research** |
| Automation, Analytics | **Data & Automation** |
| বাকি সব | **Other** |

🔴 **আলাদা কাজ দরকার:** ৩,৭৬৯টা "AI Tools" টুলের ক্যাটাগরি ঠিক করা — description/tags থেকে
reclassify করতে হবে (pipeline-এ একটা ধাপ)। এটা ছাড়া ক্যাটাগরি-গ্রিড অর্থহীন।

---

## ৪. ইমপ্রুভমেন্ট প্ল্যান — ধাপে ধাপে

### P0 — ডেটা রেজিলিয়েন্স ✅ (আজ শেষ)
- [x] staled fallback + `public/data/offline.json` + `sections.json`
- [x] `ORDER BY views` ইনডেক্স (কোটা ৩× কমাবে) — ১/৩ তৈরি, বাকি ২টা নাইটলিতে
- [ ] **যাচাই:** পরের রানের পর reads ৫M-এর নিচে নামল কি না (D1 analytics)
- **সময়:** শেষ · **নির্ভরতা:** নেই

### P1 — `/tools` browse পেজ (সবচেয়ে বেশি প্রভাব)
- [ ] `functions/tools/index.js` — SSR, URL-driven ফিল্টার
- [ ] Category chips + Price chips + Search + Sort + Pagination
- [ ] হোমপেজের "See all →" লিংক এখানে বসানো, nav-এ "All Tools"
- [ ] sitemap-এ `/tools` + প্রতি ক্যাটাগরির filtered URL
- **সময়:** ১ session · **নির্ভরতা:** P0 (ডেটা থাকা দরকার, নাহলে পেজও ফাঁকা)

### P2 — ক্যাটাগরি taxonomy
- [ ] `categories` টেবিলে ৭টা মিসিং ক্যাটাগরি যোগ করা (১৯ → সংখ্যা মেলানো)
- [ ] mapping টেবিল ধরে মূল ক্যাটাগরিগুলো merge করা
- [ ] ৩,৭৬৯টা "AI Tools" টুল reclassify (script + manual spot-check)
- [ ] হোমপেজের ক্যাটাগরি গ্রিড ৪ → ১২
- **সময়:** ১-২ session · **নির্ভরতা:** P0

### P3 — কার্ড পলিশ + নিউজ
- [ ] favicon fallback (খালি বক্স বন্ধ)
- [ ] naming validation শক্ত করা — `Visit X website`, `Raspberry Pi` ধরা পড়ুক
- [ ] "Latest News" কার্ডে আসল টাইটেল + তারিখ + থাম্বনেইল
- [ ] `toolfk.com` হার্ডকোড লিংক — বাদ দেওয়া বা অভ্যন্তরীণ পেজে বদলানো (আপনার সিদ্ধান্ত দরকার)
- **সময়:** ১ session · **নির্ভরতা:** P1

### P4 — trust signal + SEO
- [ ] কার্ডে views/upvotes (রেফারেন্সে community ranking আছে; আমাদের `views`/`votes` ফাঁকা ⇒ tick করতে হবে)
- [ ] `/alternatives/` পেজে কার্ড ডিজাইন একরকম
- [ ] structured data (ItemList + SoftwareApplication) `/tools` ও `/category`-তে
- **সময়:** ১ session · **নির্ভরতা:** P2

---

## ৫. অ্যাকসেপ্টেন্স (কে "polished" বলার যোগ্য)

| যাচাই | মান |
|---|---|
| হোমপেজ | ৯টা সেকশন, **শূন্য "Could not load"**, প্রতিটায় ≥৬টা আসল টুল |
| `/tools` | ফিল্টার+সার্চ+পেজিনেশন কাজ করে, URL শেয়ারযোগ্য, ৪০/পেজ |
| ক্যাটাগরি | ১২টা গ্রুপ, প্রতিটায় লিংক, সবচেয়ে বড় গ্রুপ < ২৫% |
| কার্ড | লোগো/ফ্যাভিকন, pricing ব্যাজ, এক-লাইনের বর্ণনা — ৩ জায়গায় একই |
| কোটা | D1 reads < ৫M/দিন (analytics-এ যাচাই) |
| fallback | D1 বন্ধ থাকলেও সাইট চলে, "Showing the last saved copy" লেখা সহ |

---

## ৬. সুপারিশ — ক্রম

1. **P0 যাচাই** (পরের রানের পর, ~০৮:০০ BD)
2. **P1 `/tools`** — এটাই সাইটকে "ডিরেক্টরি" বানায়; সেকশন ফাঁকা থাকলেও এটা কাজ করবে
3. **P2 taxonomy** — নাহলে ক্যাটাগরি গ্রিড দেখানোর মানে নেই
4. **P3 পলিশ** → **P4 trust/SEO**

P1 ও P2 একসাথে করা যায় (আলাদা ফাইল/আলাদা কাজ, সংঘর্ষ নেই)।
