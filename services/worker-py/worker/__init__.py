import os

# LiteLLM (worker/providers.py): use its bundled model cost map, never fetch one at import time.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
