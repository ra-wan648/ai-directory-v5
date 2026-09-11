CREATE TABLE tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  short_desc TEXT,
  category TEXT,
  pricing TEXT CHECK(pricing IN ('free','freemium','paid')),
  url TEXT,
  logo_url TEXT,
  logo_type TEXT DEFAULT 'favicon',
  tags TEXT,
  compatible_tools TEXT,
  views INTEGER DEFAULT 0,
  votes INTEGER DEFAULT 0,
  featured INTEGER DEFAULT 0,
  tag TEXT DEFAULT 'regular',
  status TEXT DEFAULT 'published',
  last_updated DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE blogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  content TEXT,
  meta_description TEXT,
  focus_keyword TEXT,
  faq_schema TEXT,
  category TEXT DEFAULT 'review',
  tool_slug TEXT,
  status TEXT DEFAULT 'pending',
  telegram_message_id INTEGER,
  published_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  prompt_text TEXT NOT NULL,
  description TEXT,
  category TEXT,
  compatible_tools TEXT,
  preview_image_url TEXT,
  copy_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  telegram_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  slug TEXT UNIQUE,
  icon TEXT,
  tool_count INTEGER DEFAULT 0
);

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submitted_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  url TEXT,
  category TEXT,
  short_desc TEXT,
  pricing TEXT,
  submitter_email TEXT,
  status TEXT DEFAULT 'pending',
  telegram_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SEED CATEGORIES
INSERT INTO categories (name, slug, icon) VALUES
  ('Writing', 'writing', '✍️'),
  ('Coding', 'coding', '💻'),
  ('Image', 'image', '🎨'),
  ('Video', 'video', '🎬'),
  ('Marketing', 'marketing', '📣'),
  ('Productivity', 'productivity', '⚡'),
  ('Research', 'research', '🔍'),
  ('Audio', 'audio', '🎵'),
  ('Chat', 'chat', '💬'),
  ('Business', 'business', '💼'),
  ('Automation', 'automation', '🤖'),
  ('Analytics', 'analytics', '📊');

-- SEED TOOLS (10 real tools)
INSERT INTO tools (name, slug, short_desc, description, category, pricing, url, logo_type, tags, featured, tag) VALUES
  ('ChatGPT', 'chatgpt', 'Most popular AI chatbot by OpenAI', 'ChatGPT is an AI-powered chatbot developed by OpenAI. It can write essays, summarize documents, answer questions, generate code, and much more. Available as free and paid tiers.', 'Chat', 'freemium', 'https://chat.openai.com', 'favicon', 'chat,writing,coding,openai', 1, 'featured'),
  ('Midjourney', 'midjourney', 'AI image generation from text prompts', 'Midjourney is a powerful AI image generator that creates stunning artwork from text descriptions. Used by artists, designers, and creators worldwide.', 'Image', 'paid', 'https://midjourney.com', 'favicon', 'image,design,art,generation', 1, 'featured'),
  ('Claude', 'claude-ai', 'Anthropic AI assistant for complex tasks', 'Claude by Anthropic is a safe, helpful AI assistant that excels at analysis, writing, coding, and reasoning. Known for long context and nuanced understanding.', 'Chat', 'freemium', 'https://claude.ai', 'favicon', 'chat,writing,analysis,coding', 1, 'featured'),
  ('Perplexity AI', 'perplexity-ai', 'AI-powered search with citations', 'Perplexity AI is an AI search engine that gives accurate, cited answers in real time. Great for research and fact-checking.', 'Research', 'freemium', 'https://perplexity.ai', 'favicon', 'search,research,ai', 0, 'trending'),
  ('GitHub Copilot', 'github-copilot', 'AI coding assistant inside your editor', 'GitHub Copilot suggests code completions in real time directly in VS Code, JetBrains, and other editors. Trained on billions of lines of code.', 'Coding', 'freemium', 'https://github.com/features/copilot', 'favicon', 'coding,developer,autocomplete', 0, 'trending'),
  ('ElevenLabs', 'elevenlabs', 'AI text to speech voice generator', 'ElevenLabs creates ultra-realistic AI voices from text. Clone your voice, choose from 1000+ voices, and generate audio in 29 languages.', 'Audio', 'freemium', 'https://elevenlabs.io', 'favicon', 'audio,voice,tts,speech', 0, 'regular'),
  ('Runway ML', 'runway-ml', 'AI video generation and editing tool', 'Runway creates and edits videos using AI including Gen-2 and Gen-3 video generation, background removal, and motion tracking.', 'Video', 'freemium', 'https://runwayml.com', 'favicon', 'video,generation,editing', 0, 'regular'),
  ('Notion AI', 'notion-ai', 'AI writing assistant inside Notion', 'Notion AI helps you write, summarize, translate, and brainstorm inside your Notion workspace. Integrated seamlessly into your notes.', 'Productivity', 'freemium', 'https://notion.so', 'favicon', 'productivity,writing,notes', 0, 'regular'),
  ('Copy.ai', 'copy-ai', 'AI marketing copy and content writer', 'Copy.ai generates marketing copy, blog posts, ad scripts, email campaigns, and social posts in seconds using advanced AI.', 'Marketing', 'freemium', 'https://copy.ai', 'favicon', 'marketing,writing,copy,ads', 0, 'regular'),
  ('Gemini', 'gemini', 'Google multimodal AI assistant', 'Google Gemini is a multimodal AI that understands text, images, audio, and code. Integrated across Google Workspace and Android.', 'Chat', 'freemium', 'https://gemini.google.com', 'favicon', 'chat,google,multimodal,search', 0, 'regular');

-- SEED PROMPTS (5 sample prompts)
INSERT INTO prompts (title, slug, prompt_text, description, category, compatible_tools, status) VALUES
  ('Cinematic Portrait Photography', 'cinematic-portrait', 'A cinematic portrait of a person in dramatic side lighting, shallow depth of field, 85mm lens, golden hour, film grain, hyper realistic, award winning photography', 'Create stunning cinematic portrait photos with professional lighting', 'image', 'midjourney,dalle,stable-diffusion', 'published'),
  ('Explain Like I am 10', 'explain-like-10', 'Explain [TOPIC] to me like I am 10 years old. Use simple words, fun analogies, and a short example to make it easy to understand.', 'Get simple explanations for any complex topic', 'text', 'chatgpt,claude,gemini', 'published'),
  ('Cold Email Writer', 'cold-email-writer', 'Write a cold email to [TARGET PERSON] at [COMPANY] about [YOUR PRODUCT/SERVICE]. Make it personal, under 150 words, with a clear CTA. No fluff.', 'Write effective cold emails that get replies', 'text', 'chatgpt,claude', 'published'),
  ('Futuristic City Concept Art', 'futuristic-city', 'Futuristic megacity at night, neon lights reflecting on wet streets, flying vehicles, cyberpunk aesthetic, ultra detailed, 8k, blade runner style, concept art', 'Generate breathtaking futuristic cityscape concept art', 'image', 'midjourney,stable-diffusion', 'published'),
  ('Code Reviewer', 'code-reviewer', 'Review this code and provide: 1) Bugs or errors found 2) Performance improvements 3) Security issues 4) Better alternatives. Be specific with line numbers.

[PASTE CODE HERE]', 'Get professional code reviews from AI', 'text', 'chatgpt,claude,gemini', 'published');
