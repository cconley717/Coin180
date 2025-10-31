from __future__ import annotations

import base64
from dataclasses import dataclass
import os
from typing import Any, Dict, Optional, Tuple

import numpy as np

try:
    import pyvips
except Exception as exc:
    raise RuntimeError(
        "pyvips (and the libvips runtime) is required for the GPU heatmap analyzer. "
        "Install libvips and ensure it is on PATH before running GPU replays."
    ) from exc

AGENT_PREF = os.environ.get("HEATMAP_PROCESSING_AGENT", "cpu").lower()
if AGENT_PREF not in ("cpu", "gpu"):
    raise RuntimeError('HEATMAP_PROCESSING_AGENT must be set to either "cpu" or "gpu".')

if AGENT_PREF == "gpu":
    try:
        import cupy as cp
    except ImportError as exc:  # pragma: no cover - configuration error
        raise RuntimeError(
            'HEATMAP_PROCESSING_AGENT="gpu" but CuPy is not installed. '
            "Install CuPy (e.g., pip install cupy-cuda11x) or set HEATMAP_PROCESSING_AGENT=cpu."
        ) from exc
    XP = cp
    GPU_BACKEND = "cupy"
else:
    cp = None  # type: ignore[assignment]
    XP = np
    GPU_BACKEND = "numpy"

if cp is not None:
    try:
        from cupyx.scipy import ndimage as cupy_ndimage  # type: ignore[attr-defined]
    except Exception:  # pragma: no cover - optional dependency
        cupy_ndimage = None
else:
    cupy_ndimage = None

try:
    import scipy.ndimage as scipy_ndimage  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - optional dependency
    scipy_ndimage = None


@dataclass
class HeatmapBuffers:
    rgb_raw: Any
    alpha_raw: Any
    hsv_raw: Any
    lightness_raw: Any
    rgb_blurred: Any
    alpha_blurred: Any
    hsv_blurred: Any
    lightness_blurred: Any
    width: int
    height: int


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


def _vips_image_to_numpy(image: "pyvips.Image", dtype: np.dtype) -> np.ndarray:
    array = np.frombuffer(image.write_to_memory(), dtype=dtype)
    if image.bands == 1:
        return array.reshape(image.height, image.width)
    return array.reshape(image.height, image.width, image.bands)


def _load_heatmap_buffers(
    png_bytes: bytes,
    sigma: float
) -> HeatmapBuffers:
    try:
        image = pyvips.Image.new_from_buffer(png_bytes, "", access="random")
    except pyvips.Error as exc:
        raise RuntimeError(f"Failed to decode heatmap via pyvips: {exc}") from exc

    if image.interpretation != "srgb":
        image = image.colourspace("srgb")

    if image.bands == 1:
        image = image.colourspace("srgb")
    elif image.bands == 2:
        base = image.extract_band(0).colourspace("srgb")
        alpha = image.extract_band(1)
        image = base.bandjoin(alpha)
    elif image.bands == 3:
        image = image.bandjoin(255)
    elif image.bands > 4:
        image = image.extract_band(0, n=4)

    image = image.cast("uchar")

    width = image.width
    height = image.height
    rgb_image = image.extract_band(0, n=3)

    raw_np = _vips_image_to_numpy(image, np.uint8).astype(np.float32)

    premultiplied = image.premultiply()
    blurred = premultiplied.gaussblur(sigma, precision="integer")
    unpremultiplied = blurred.unpremultiply()
    if unpremultiplied.format != "uchar":
        unpremultiplied = unpremultiplied.cast("uchar")

    blur_np = _vips_image_to_numpy(unpremultiplied, np.uint8).astype(np.float32)

    hsv_raw_img = rgb_image.colourspace("hsv")
    if hsv_raw_img.format != "float":
        hsv_raw_img = hsv_raw_img.cast("float")
    hsv_raw_np = _vips_image_to_numpy(hsv_raw_img, np.float32)

    lab_raw_img = rgb_image.colourspace("lab")
    if lab_raw_img.format != "float":
        lab_raw_img = lab_raw_img.cast("float")
    lightness_np = _vips_image_to_numpy(lab_raw_img.extract_band(0), np.float32) / 100.0

    blurred_rgb_image = unpremultiplied.extract_band(0, n=3)
    hsv_blur_img = blurred_rgb_image.colourspace("hsv")
    if hsv_blur_img.format != "float":
        hsv_blur_img = hsv_blur_img.cast("float")
    hsv_blur_np = _vips_image_to_numpy(hsv_blur_img, np.float32)
    lab_blur_img = blurred_rgb_image.colourspace("lab")
    if lab_blur_img.format != "float":
        lab_blur_img = lab_blur_img.cast("float")
    lightness_blur_np = _vips_image_to_numpy(lab_blur_img.extract_band(0), np.float32) / 100.0

    rgb_raw = XP.asarray(raw_np[..., :3])
    alpha_raw = XP.asarray(raw_np[..., 3])
    rgb_blurred = XP.asarray(blur_np[..., :3])
    alpha_blurred = XP.asarray(blur_np[..., 3])

    hsv_raw = XP.asarray(hsv_raw_np)
    lightness_raw = XP.asarray(lightness_np)
    hsv_blurred = XP.asarray(hsv_blur_np)
    lightness_blurred = XP.asarray(lightness_blur_np)

    return HeatmapBuffers(
        rgb_raw=rgb_raw,
        alpha_raw=alpha_raw,
        hsv_raw=hsv_raw,
        lightness_raw=lightness_raw,
        rgb_blurred=rgb_blurred,
        alpha_blurred=alpha_blurred,
        hsv_blurred=hsv_blurred,
        lightness_blurred=lightness_blurred,
        width=width,
        height=height,
    )


def _percentile(arr: "XP.ndarray", p: float) -> float:
    if arr.size == 0:
        return 0.0
    return _to_scalar(XP.percentile(arr, p * 100.0))


def _classify_families(
    hue: "XP.ndarray",
    saturation: "XP.ndarray",
    value: "XP.ndarray",
    alpha: "XP.ndarray",
    opts: Dict[str, Any],
    min_saturation: float,
) -> Tuple["XP.ndarray", "XP.ndarray", "XP.ndarray"]:
    alpha_mask = alpha >= 8.0
    sat_mask = saturation >= min_saturation
    val_mask = value >= opts["minValue"]

    active = alpha_mask & sat_mask & val_mask

    green_cond = (hue >= opts["greenHueMin"]) & (hue <= opts["greenHueMax"])
    red_cond = (hue <= opts["redHueLowMax"]) | (hue >= 360.0 - opts["redHueLowMax"])

    green_mask = active & green_cond
    red_mask = active & (~green_mask) & red_cond
    neutral_mask = ~(green_mask | red_mask)

    return green_mask, red_mask, neutral_mask


def _auto_tune_min_saturation(
    saturation: "XP.ndarray",
    value: "XP.ndarray",
    alpha: "XP.ndarray",
    opts: Dict[str, Any],
) -> float:
    mask = (alpha >= 8.0) & (value >= opts["minValue"])
    samples = saturation[mask]

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
    hue: "XP.ndarray",
    saturation: "XP.ndarray",
    value: "XP.ndarray",
    alpha: "XP.ndarray",
    lightness: "XP.ndarray",
    opts: Dict[str, Any],
    min_saturation: float,
) -> Tuple["XP.ndarray", "XP.ndarray", int, int]:
    green_mask, red_mask, neutral_mask = _classify_families(hue, saturation, value, alpha, opts, min_saturation)

    green_lightness = lightness[green_mask]
    red_lightness = lightness[red_mask]

    neutral = _to_int(XP.count_nonzero(neutral_mask))
    candidates = _to_int(XP.count_nonzero(~neutral_mask))

    return green_lightness, red_lightness, neutral, candidates


def _compute_shade_cutoffs(green_l: "XP.ndarray", red_l: "XP.ndarray", opts: Dict[str, Any]) -> Tuple[float, float, float, float]:
    g_b1, g_b2 = 0.45, 0.7
    r_b1, r_b2 = 0.45, 0.7

    if green_l.size >= 10:
        g_b1 = _percentile(XP.sort(green_l), 0.33)
        g_b2 = _percentile(XP.sort(green_l), 0.66)

    if red_l.size >= 10:
        r_b1 = _percentile(XP.sort(red_l), 0.33)
        r_b2 = _percentile(XP.sort(red_l), 0.66)

    def widen(b1: float, b2: float, arr: "XP.ndarray") -> Tuple[float, float]:
        if abs(b2 - b1) < float(opts["collapseEps"]):
            med = _percentile(XP.sort(arr), 0.5)
            widened = (med - float(opts["collapseWiden"]) * 0.5, med + float(opts["collapseWiden"]) * 0.5)
            return widened
        return b1, b2

    if green_l.size:
        g_b1, g_b2 = widen(g_b1, g_b2, green_l)
    if red_l.size:
        r_b1, r_b2 = widen(r_b1, r_b2, red_l)

    return g_b1, g_b2, r_b1, r_b2


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


def _convolve_with_kernel(mask_float: "XP.ndarray") -> "XP.ndarray":
    """Apply 3x3 convolution kernel to count neighbors (excludes center pixel)."""
    kernel_np = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.float32)

    if cp is not None and isinstance(mask_float, cp.ndarray) and cupy_ndimage is not None:
        kernel = cp.asarray(kernel_np)
        return cupy_ndimage.convolve(mask_float, kernel, mode="constant", cval=0.0)
    
    if isinstance(mask_float, np.ndarray) and scipy_ndimage is not None:
        return scipy_ndimage.convolve(mask_float, kernel_np, mode="constant", cval=0.0)
    
    return _manual_neighbor_count(mask_float)


def _manual_neighbor_count(mask_float: "XP.ndarray") -> "XP.ndarray":
    """Manually count neighbors by shifting array (fallback when scipy/cupy unavailable)."""
    neighbors = XP.zeros_like(mask_float)
    
    for dy in range(-1, 2):
        for dx in range(-1, 2):
            if dy == 0 and dx == 0:
                continue
            neighbors = neighbors + _shift_array(mask_float, dy, dx)
    
    return neighbors


def _apply_neighbor_filter(mask: "XP.ndarray", neighbor_min: int) -> "XP.ndarray":
    """Filter mask to only include pixels with sufficient neighbor agreement."""
    if neighbor_min <= 0:
        return mask

    mask_float = mask.astype(XP.float32)
    neighbors = _convolve_with_kernel(mask_float)
    
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

    sigma = float(options["thresholdBlurSigma"])
    buffers = _load_heatmap_buffers(png_bytes, sigma)

    hue_raw = buffers.hsv_raw[..., 0]
    sat_raw = buffers.hsv_raw[..., 1]
    val_raw = buffers.hsv_raw[..., 2]
    hue_blur = buffers.hsv_blurred[..., 0]
    sat_blur = buffers.hsv_blurred[..., 1]
    val_blur = buffers.hsv_blurred[..., 2]

    min_saturation = float(options["minSaturation"])
    if options.get("autoTuneMinSaturation", False):
        min_saturation = _auto_tune_min_saturation(sat_blur, val_blur, buffers.alpha_blurred, options)

    pixel_step = int(options["pixelStep"])
    sampled_hue_blur = hue_blur[::pixel_step, ::pixel_step]
    sampled_sat_blur = sat_blur[::pixel_step, ::pixel_step]
    sampled_val_blur = val_blur[::pixel_step, ::pixel_step]
    sampled_alpha_blur = buffers.alpha_blurred[::pixel_step, ::pixel_step]
    sampled_lightness_blur = buffers.lightness_blurred[::pixel_step, ::pixel_step]

    green_l, red_l, neutral_count, candidate_count = _collect_lightness(
        sampled_hue_blur,
        sampled_sat_blur,
        sampled_val_blur,
        sampled_alpha_blur,
        sampled_lightness_blur,
        options,
        min_saturation,
    )

    g_b1, g_b2, r_b1, r_b2 = _compute_shade_cutoffs(green_l, red_l, options)
    force_green, force_red = _detect_uniform_shades(green_l, red_l, options)

    green_mask_raw, red_mask_raw, _ = _classify_families(
        hue_raw,
        sat_raw,
        val_raw,
        buffers.alpha_raw,
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
    sampled_lightness = buffers.lightness_raw[::pixel_step, ::pixel_step]

    green_light, green_medium, green_dark = _shade_counts(sampled_green, sampled_lightness, g_b1, g_b2, force_green)
    red_light, red_medium, red_dark = _shade_counts(sampled_red, sampled_lightness, r_b1, r_b2, force_red)

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
                "green": {"b1": g_b1, "b2": g_b2},
                "red": {"b1": r_b1, "b2": r_b2},
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
