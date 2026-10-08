#!/usr/bin/env python3
"""
Stage notifications for the pipeline.
Usage: python notify.py "stage message here"
Sends a short Telegram message to the admin. Never fails the pipeline.
"""
import sys
import os

from config import load_env

load_env()


def main():
    msg = ' '.join(sys.argv[1:]) or '(empty)'
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    chat = os.environ.get('ADMIN_TELEGRAM_ID', '')
    if not token or not chat:
        print('[notify] Telegram not configured, skipping')
        return
    try:
        import requests
        r = requests.post(
            f'https://api.telegram.org/bot{token}/sendMessage',
            json={'chat_id': chat, 'text': msg, 'parse_mode': 'HTML'},
            timeout=15)
        print('[notify] sent:', r.status_code)
    except Exception as e:
        print(f'[notify] failed: {e}')


if __name__ == '__main__':
    main()
