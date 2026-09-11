import requests
import os
from config import load_env

load_env()

TOKEN = os.environ['TELEGRAM_BOT_TOKEN']
ADMIN = os.environ['ADMIN_TELEGRAM_ID']
BASE = f"https://api.telegram.org/bot{TOKEN}"


def send(method, data):
    try:
        r = requests.post(f"{BASE}/{method}", json=data, timeout=15)
        return r.json()
    except Exception as e:
        print(f"[ERROR] Telegram {method}: {e}")
        return None


def send_blog_notification(blog, blog_id):
    text = (
        f"📝 <b>New Blog Ready!</b>\n\n"
        f"📌 <b>Title:</b> {blog.get('title', '')}\n"
        f"🎯 <b>Keyword:</b> {blog.get('focus_keyword', '')}\n"
        f"📂 <b>Category:</b> {blog.get('category', '')}\n"
        f"📊 <b>Meta:</b> {blog.get('meta_description', '')[:100]}"
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✅ Approve", "callback_data": f"approve_blog_{blog_id}"},
        {"text": "❌ Reject", "callback_data": f"reject_blog_{blog_id}"}
    ]]}
    r = send("sendMessage", {
        "chat_id": ADMIN, "text": text,
        "parse_mode": "HTML", "reply_markup": keyboard
    })
    return r.get('result', {}).get('message_id') if r else None


def send_prompt_notification(prompt, prompt_id):
    preview = prompt.get('prompt_text', '')[:100]
    text = (
        f"🎨 <b>New Prompt Ready!</b>\n\n"
        f"📌 <b>Title:</b> {prompt.get('title', '')}\n"
        f"🔧 <b>For:</b> {prompt.get('compatible_tools', '')}\n"
        f"📝 <b>Preview:</b> {preview}..."
    )
    keyboard = {"inline_keyboard": [[
        {"text": "✅ Approve", "callback_data": f"approve_prompt_{prompt_id}"},
        {"text": "❌ Reject", "callback_data": f"reject_prompt_{prompt_id}"}
    ]]}
    send("sendMessage", {
        "chat_id": ADMIN, "text": text,
        "parse_mode": "HTML", "reply_markup": keyboard
    })


def send_error(msg):
    send("sendMessage", {
        "chat_id": ADMIN,
        "text": f"⚠️ <b>Pipeline Error!</b>\n\n<code>{str(msg)[:400]}</code>",
        "parse_mode": "HTML"
    })


def send_summary(tools, blogs, prompts, errors):
    send("sendMessage", {
        "chat_id": ADMIN,
        "text": (
            f"✅ <b>Pipeline Complete!</b>\n\n"
            f"🔧 Tools added: <b>{tools}</b>\n"
            f"📝 Blogs generated: <b>{blogs}</b>\n"
            f"🎨 Prompts generated: <b>{prompts}</b>\n"
            f"⚠️ Errors: <b>{errors}</b>"
        ),
        "parse_mode": "HTML"
    })
