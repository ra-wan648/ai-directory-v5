import os
from pathlib import Path

ENV_FILE = Path(__file__).parent / '.env.local'


def load_env():
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip()
        if key and key not in os.environ:
            os.environ[key] = value
