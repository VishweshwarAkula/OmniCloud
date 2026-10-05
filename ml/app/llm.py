"""A very small local LLM (Qwen3-0.6B, 4-bit GGUF via llama.cpp) for query understanding.

It reads what rules can't: typos in names ("rahl" → Rahul), other languages ("perros en la playa"
→ "dogs on the beach") and paraphrase. It never does date math (rules do that) and its names are
validated against the user's known people/places by the caller. ~1 s per query on a laptop CPU;
nothing leaves the machine.
"""

import json
import logging
import os
import threading

log = logging.getLogger(__name__)

SYSTEM = """You turn a photo-library search into JSON.
- people: names from KNOWN PEOPLE that the query mentions (fix typos). Never add anyone else.
- places: names from KNOWN PLACES that the query mentions (fix typos). Never add others.
- kinds: only if the query asks for that type of file: screenshot, document, receipt, illustration, chart,
  meme. Usually empty.
- visual_query: what should be visible in the image, in short plain English (translate other languages).
  Remove people names, place names, dates and times, and words like photos/pictures. null if nothing is left.
Answer with JSON only."""

# Few-shot examples (with their own made-up names, so they never leak into real answers).
EXAMPLES = [
    ("leo playing football in paris 2023", ["Leo"], ["Paris"], "playing football", ["Leo"], ["Paris"], []),
    ("screenshots of bank messages", [], [], "bank messages", [], [], ["screenshot"]),
    ("my cat sleeping on the bed", [], [], "cat sleeping on the bed", [], [], []),
    ("fotos de niños en la nieve", [], [], "children in the snow", [], [], []),
    ("bills from march", [], [], None, [], [], ["receipt"]),
    (
        "priya and rahul at the mumbai airport",
        ["Priya", "Rahul"],
        ["Mumbai"],
        "airport",
        ["Priya", "Rahul"],
        ["Mumbai"],
        [],
    ),
    ("red flowers", [], [], "red flowers", [], [], []),
]

_NO_THINK = "<think>\n\n</think>\n\n"  # Qwen3: an empty thinking block = answer directly


def _turn(role: str, text: str) -> str:
    return f"<|im_start|>{role}\n{text}<|im_end|>\n"


def _known(people: list[str], places: list[str]) -> str:
    return f"KNOWN PEOPLE: {', '.join(people) or 'none'}\nKNOWN PLACES: {', '.join(places) or 'none'}"


class LocalLLM:
    def __init__(self, model_path: str, threads: int = 0):
        from llama_cpp import Llama

        # Physical cores: hyper-threads don't speed up token generation.
        threads = threads or max(1, (os.cpu_count() or 2) // 2)
        self.llm = Llama(model_path=model_path, n_ctx=2048, n_threads=threads, n_batch=512, verbose=False)
        self.name = os.path.basename(model_path)
        self._lock = threading.Lock()

    def _prompt(self, query: str, people: list[str], places: list[str]) -> str:
        shots = "".join(
            _turn("user", f"{_known(kp, kl)}\nQuery: {q}")
            + _turn(
                "assistant",
                _NO_THINK + json.dumps({"visual_query": v, "people": p, "places": pl, "kinds": k}, ensure_ascii=False),
            )
            for q, kp, kl, v, p, pl, k in EXAMPLES
        )
        # The answer is pre-filled up to its first value: fewer tokens to generate, always valid JSON keys.
        return (
            _turn("system", SYSTEM)
            + shots
            + _turn("user", f"{_known(people[:100], places[:100])}\nQuery: {query}")
            + "<|im_start|>assistant\n"
            + _NO_THINK
            + '{"visual_query":'
        )

    def extract(self, query: str, people: list[str], places: list[str]) -> dict:
        prompt = self._prompt(query, people, places)
        with self._lock:  # llama.cpp contexts aren't thread-safe
            out = self.llm.create_completion(prompt, max_tokens=64, temperature=0, stop=["<|im_end|>", "}"])
        data = json.loads('{"visual_query":' + out["choices"][0]["text"] + "}")
        return {
            "visual_query": data.get("visual_query") if isinstance(data.get("visual_query"), str) else None,
            "people": [x for x in data.get("people") or [] if isinstance(x, str)],
            "places": [x for x in data.get("places") or [] if isinstance(x, str)],
            "kinds": [x for x in data.get("kinds") or [] if isinstance(x, str)],
        }
