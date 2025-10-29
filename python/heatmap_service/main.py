import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from gpu_heatmap_analyzer import analyze_heatmap


class HeatmapAnalyzerError(Exception):
    pass

@dataclass
class HeatmapRequest:
    png_base64: str
    options: Dict[str, Any]

    @classmethod
    def from_json(cls, payload: Dict[str, Any]) -> "HeatmapRequest":
        try:
            png_base64 = str(payload["pngBase64"])
            options_raw = payload.get("options", {})
        except (KeyError, ValueError, TypeError) as exc:
            raise ValueError(f"Invalid payload: {payload}") from exc

        if not png_base64:
            raise ValueError("pngBase64 must be a non-empty base64 string.")

        if not isinstance(options_raw, dict):
            raise ValueError("options must be an object.")

        return cls(png_base64=png_base64, options=options_raw)


def make_response(request: HeatmapRequest) -> Dict[str, Any]:
    try:
        heatmap = analyze_heatmap(request.png_base64, request.options)
        return {
            "heatmap": heatmap,
        }
    except Exception as exc:  # noqa: BLE001
        raise HeatmapAnalyzerError(str(exc)) from exc


def process_stream() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            request = HeatmapRequest.from_json(payload)
            response = make_response(request)
        except Exception as exc:  # noqa: BLE001 - return structured error
            response = {
                "error": str(exc),
            }

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    sys.exit(process_stream())
