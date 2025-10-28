from __future__ import annotations

import base64
import io
from typing import Any, Dict, Optional, Tuple

import numpy as np
from PIL import Image

try:
    import cupy as cp

    XP = cp
    GPU_BACKEND = "cupy"
except ImportError:
    cp = None  # type: ignore[assignment]
    XP = np
    GPU_BACKEND = "numpy"


def _to_scalar(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)

    if cp is not None and isinstance(value, cp.ndarray):
        return float(value.get().item())

    if isinstance(value, np.ndarray):
        return float(value.item())

    return float(value)


def _to_int(value: Any) -> int:
    return int(round(_to_scalar(value)))


def _load_image_rgba(png_bytes: bytes) -> np.ndarray:
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    return np.asarray(image, dtype=np.float32)


def _rgb_to_hsv(rgb: "XP.ndarray") -> Tuple["XP.ndarray", "XP.ndarray", "XP.ndarray"]:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    maxc = XP.maximum(XP.maximum(r, g), b)
    minc = XP.minimum(XP.minimum(r, g), b)
    delta = maxc - minc

    h = XP.zeros_like(maxc)
    nonzero = delta != 0

    r_idx = nonzero & (maxc == r)
    g_idx = nonzero & (maxc == g)
    b_idx = nonzero & (maxc == b)

    # Avoid division by zero by masking with nonzero
    delta_safe = XP.where(nonzero, delta, 1)

    h = XP.where(
        r_idx,
        XP.mod((g - b) / delta_safe, 6),
        h,
    )
    h = XP.where(
        g_idx,
        ((b - r) / delta_safe) + 2,
        h,
    )
    h = XP.where(
        b_idx,
        ((r - g) / delta_safe) + 4,
        h,
    )

    h = XP.mod(h * 60.0, 360.0)
    s = XP.where(maxc == 0, 0.0, delta / XP.maximum(maxc, 1e-9))
    v = maxc

    return h, s, v


def _hsl_lightness(rgb: "XP.ndarray") -> "XP.ndarray":
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    maxc = XP.maximum(XP.maximum(r, g), b)
    minc = XP.minimum(XP.minimum(r, g), b)
    return (maxc + minc) * 0.5


def _percentile(arr: "XP.ndarray", p: float) -> float:
    if arr.size == 0:
        return 0.0
    return _to_scalar(XP.percentile(arr, p * 100.0))


def _classify_families(
    rgb: "XP.ndarray",
    alpha: "XP.ndarray",
    opts: Dict[str, Any],
    min_saturation: float,
) -> Tuple["XP.ndarray", "XP.ndarray", "XP.ndarray", "XP.ndarray", "XP.ndarray", "XP.ndarray"]:
    h, s, v = _rgb_to_hsv(rgb)
    lightness = _hsl_lightness(rgb)

    alpha_mask = alpha >= 8.0
    sat_mask = s >= min_saturation
    val_mask = v >= opts["minValue"]

    active = alpha_mask & sat_mask & val_mask

    green_cond = (h >= opts["greenHueMin"]) & (h <= opts["greenHueMax"])
    red_cond = (h <= opts["redHueLowMax"]) | (h >= 360.0 - opts["redHueLowMax"])

    green_mask = active & green_cond
    red_mask = active & (~green_mask) & red_cond
    neutral_mask = ~(green_mask | red_mask)

    return green_mask, red_mask, neutral_mask, h, s, lightness


def _auto_tune_min_saturation(
    rgb: "XP.ndarray",
    alpha: "XP.ndarray",
    opts: Dict[str, Any],
) -> float:
    h, s, v = _rgb_to_hsv(rgb)

    mask = (alpha >= 8.0) & (v >= opts["minValue"])
    samples = s[mask]

    if samples.size < 50:
        return float(opts["minSaturation"])

    percentile_value = _percentile(
        XP.sort(samples),
        float(np.clip(opts["autoTuneSPercentile"], 0.05, 0.95)),
    )
    tuned = max(
        float(opts["autoTuneSMinFloor"]),
        min(float(opts["minSaturation"]), percentile_value * 0.95),
    )

    return tuned


def _collect_lightness(
    rgb: "XP.ndarray",
    alpha: "XP.ndarray",
    opts: Dict[str, Any],
    min_saturation: float,
) -> Tuple["XP.ndarray", "XP.ndarray", int, int]:
    green_mask, red_mask, neutral_mask, _, _, lightness = _classify_families(rgb, alpha, opts, min_saturation)

    green_lightness = lightness[green_mask]
    red_lightness = lightness[red_mask]

    neutral = _to_int(XP.count_nonzero(neutral_mask))
    candidates = _to_int(XP.count_nonzero(~neutral_mask))

    return green_lightness, red_lightness, neutral, candidates


def _compute_shade_cutoffs(green_l: "XP.ndarray", red_l: "XP.ndarray", opts: Dict[str, Any]) -> Tuple[float, float, float, float]:
    gB1, gB2 = 0.45, 0.7
    rB1, rB2 = 0.45, 0.7

    if green_l.size >= 10:
        gB1 = _percentile(XP.sort(green_l), 0.33)
        gB2 = _percentile(XP.sort(green_l), 0.66)

    if red_l.size >= 10:
        rB1 = _percentile(XP.sort(red_l), 0.33)
        rB2 = _percentile(XP.sort(red_l), 0.66)

    def widen(b1: float, b2: float, arr: "XP.ndarray") -> Tuple[float, float]:
        if abs(b2 - b1) < float(opts["collapseEps"]):
            med = _percentile(XP.sort(arr), 0.5)
            widened = (med - float(opts["collapseWiden"]) * 0.5, med + float(opts["collapseWiden"]) * 0.5)
            return widened
        return b1, b2

    if green_l.size:
        gB1, gB2 = widen(gB1, gB2, green_l)
    if red_l.size:
        rB1, rB2 = widen(rB1, rB2, red_l)

    return gB1, gB2, rB1, rB2


def _detect_uniform_shades(
    green_l: "XP.ndarray",
    red_l: "XP.ndarray",
    opts: Dict[str, Any],
) -> Tuple[Optional[str], Optional[str]]:
    if not opts.get("uniformDetect", False):
        return None, None

    def uniform(arr: "XP.ndarray") -> Optional[str]:
        if arr.size < 50:
            return None

        p05 = _percentile(arr, 0.05)
        p95 = _percentile(arr, 0.95)
        spread = p95 - p05

        if spread >= float(opts["uniformSpreadMax"]):
            return None

        med = _percentile(arr, 0.5)
        if med >= float(opts["uniformLightL"]):
            return "light"
        if med <= float(opts["uniformDarkL"]):
            return "dark"
        return "medium"

    return uniform(green_l), uniform(red_l)


def _shift_array(arr: "XP.ndarray", dy: int, dx: int) -> "XP.ndarray":
    out = XP.zeros_like(arr)

    h, w = arr.shape[:2]

    src_y_start = max(0, -dy)
    src_y_end = h - max(0, dy)
    src_x_start = max(0, -dx)
    src_x_end = w - max(0, dx)

    if src_y_start >= src_y_end or src_x_start >= src_x_end:
        return out

    dst_y_start = max(0, dy)
    dst_y_end = dst_y_start + (src_y_end - src_y_start)
    dst_x_start = max(0, dx)
    dst_x_end = dst_x_start + (src_x_end - src_x_start)

    out[dst_y_start:dst_y_end, dst_x_start:dst_x_end, ...] = arr[src_y_start:src_y_end, src_x_start:src_x_end, ...]
    return out


def _simple_blur(rgb: "XP.ndarray", sigma: float) -> "XP.ndarray":
    radius = max(0, int(round(sigma * 1.5)))
    if radius <= 0:
        return rgb

    total = XP.zeros_like(rgb)
    count = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            total = total + _shift_array(rgb, dy, dx)
            count += 1

    return total / max(1, count)


def _apply_neighbor_filter(mask: "XP.ndarray", neighbor_min: int) -> "XP.ndarray":
    neighbors = XP.zeros_like(mask, dtype=XP.float32)

    for dy in range(-1, 2):
        for dx in range(-1, 2):
            if dy == 0 and dx == 0:
                continue
            neighbors = neighbors + _shift_array(mask.astype(XP.float32), dy, dx)

    return XP.logical_and(mask, neighbors >= neighbor_min)


def _shade_counts(
    allowed_mask: "XP.ndarray",
    lightness: "XP.ndarray",
    b1: float,
    b2: float,
    forced: Optional[str],
) -> Tuple[int, int, int]:
    total = _to_int(XP.count_nonzero(allowed_mask))

    if forced:
        light = total if forced == "light" else 0
        medium = total if forced == "medium" else 0
        dark = total if forced == "dark" else 0
        return light, medium, dark

    light_mask = XP.logical_and(allowed_mask, lightness >= b2)
    dark_mask = XP.logical_and(allowed_mask, lightness < b1)
    medium_mask = XP.logical_and(allowed_mask, XP.logical_not(light_mask | dark_mask))

    light = _to_int(XP.count_nonzero(light_mask))
    medium = _to_int(XP.count_nonzero(medium_mask))
    dark = _to_int(XP.count_nonzero(dark_mask))

    return light, medium, dark


def _merge_small(counts: Dict[str, int], min_share: float) -> None:
    total = counts["total"]
    if total == 0:
        return

    cut = int(np.ceil(total * min_share))

    if 0 < counts["dark"] < cut:
        counts["medium"] += counts["dark"]
        counts["dark"] = 0

    if 0 < counts["medium"] < cut:
        counts["light"] += counts["medium"]
        counts["medium"] = 0


def _compute_percentages(counts: Dict[str, Dict[str, int]]) -> Dict[str, Dict[str, float]]:
    def pct(n: int, d: int) -> float:
        return (n / d) if d else 0.0

    return {
        "green": {
            "light": pct(counts["green"]["light"], counts["green"]["total"]),
            "medium": pct(counts["green"]["medium"], counts["green"]["total"]),
            "dark": pct(counts["green"]["dark"], counts["green"]["total"]),
        },
        "red": {
            "light": pct(counts["red"]["light"], counts["red"]["total"]),
            "medium": pct(counts["red"]["medium"], counts["red"]["total"]),
            "dark": pct(counts["red"]["dark"], counts["red"]["total"]),
        },
    }


def _compute_score(counts: Dict[str, Dict[str, int]], analyzed_pixels: int, opts: Dict[str, Any]) -> Tuple[int, Dict[str, float]]:
    g_total = counts["green"]["total"]
    r_total = counts["red"]["total"]

    direction = (g_total - r_total) / max(1, g_total + r_total)

    weights = opts["weights"]

    def avg_strength(side: Dict[str, int]) -> float:
        total = side["total"]
        if total == 0:
            return 0.0
        return (
            side["light"] * weights["light"]
            + side["medium"] * weights["medium"]
            + side["dark"] * weights["dark"]
        ) / (total * weights["dark"])

    intensity = avg_strength(counts["green"]) if direction >= 0 else avg_strength(counts["red"])
    intensity = float(np.power(intensity, opts["shadeGamma"]))

    coverage = (g_total + r_total) / max(1, analyzed_pixels)
    coverage_floor = float(opts["coverageFloor"])
    if coverage_floor:
        cover_factor = np.clip((coverage - coverage_floor) / (1 - coverage_floor), 0, 1)
    else:
        cover_factor = 1.0

    sentiment_score = int(round(100 * direction * intensity * cover_factor))

    debug = {
        "direction": direction,
        "intensity": intensity,
        "coverage": coverage,
    }

    return sentiment_score, debug


def analyze_heatmap(png_base64: str, options: Dict[str, Any]) -> Dict[str, Any]:
    png_bytes = base64.b64decode(png_base64)
    rgba_np = _load_image_rgba(png_bytes)

    rgba = XP.asarray(rgba_np)
    rgb_raw = rgba[..., :3] / 255.0
    alpha = rgba[..., 3]

    sigma = float(options["thresholdBlurSigma"])
    rgb_blurred = _simple_blur(rgb_raw, sigma)

    min_saturation = float(options["minSaturation"])
    if options.get("autoTuneMinSaturation", False):
        min_saturation = _auto_tune_min_saturation(rgb_blurred, alpha, options)

    pixel_step = int(options["pixelStep"])
    sampled_rgb_blur = rgb_blurred[::pixel_step, ::pixel_step, :]
    sampled_alpha_blur = alpha[::pixel_step, ::pixel_step]

    green_l, red_l, neutral_count, candidate_count = _collect_lightness(
        sampled_rgb_blur,
        sampled_alpha_blur,
        options,
        min_saturation,
    )

    gB1, gB2, rB1, rB2 = _compute_shade_cutoffs(green_l, red_l, options)
    force_green, force_red = _detect_uniform_shades(green_l, red_l, options)

    green_mask_raw, red_mask_raw, neutral_mask_raw, _, _, lightness_raw = _classify_families(
        rgb_raw,
        alpha,
        options,
        min_saturation,
    )

    if options.get("neighborFilter", False):
        filtered_green = _apply_neighbor_filter(green_mask_raw, int(options["neighborAgreeMin"]))
        filtered_red = _apply_neighbor_filter(red_mask_raw, int(options["neighborAgreeMin"]))
    else:
        filtered_green = green_mask_raw
        filtered_red = red_mask_raw

    sampled_green = filtered_green[::pixel_step, ::pixel_step]
    sampled_red = filtered_red[::pixel_step, ::pixel_step]
    sampled_lightness = lightness_raw[::pixel_step, ::pixel_step]

    green_light, green_medium, green_dark = _shade_counts(sampled_green, sampled_lightness, gB1, gB2, force_green)
    red_light, red_medium, red_dark = _shade_counts(sampled_red, sampled_lightness, rB1, rB2, force_red)

    counts = {
        "green": {
            "light": green_light,
            "medium": green_medium,
            "dark": green_dark,
            "total": green_light + green_medium + green_dark,
        },
        "red": {
            "light": red_light,
            "medium": red_medium,
            "dark": red_dark,
            "total": red_light + red_medium + red_dark,
        },
        "neutral": neutral_count,
        "analyzedPixels": candidate_count,
    }

    raw_counts = {
        "green": counts["green"].copy(),
        "red": counts["red"].copy(),
    }

    _merge_small(counts["green"], float(options["minShadeShare"]))
    _merge_small(counts["red"], float(options["minShadeShare"]))

    percentages = _compute_percentages(counts)
    sentiment_score, score_debug = _compute_score(counts, candidate_count, options)

    return {
        "result": {
            "counts": counts,
            "rawCounts": raw_counts,
            "percentages": percentages,
            "thresholds": {
                "green": {"b1": gB1, "b2": gB2},
                "red": {"b1": rB1, "b2": rB2},
            },
            "sentimentScore": sentiment_score,
        },
        "debug": {
            **score_debug,
            "minSaturationTuned": min_saturation,
            "forcedGreenShade": force_green,
            "forcedRedShade": force_red,
            "backend": GPU_BACKEND,
        },
    }
