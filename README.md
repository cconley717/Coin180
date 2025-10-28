# dYO? Coin180
*A coin360.com market sentiment quantifier and trend reversal predictor.*

---

## dY"- Overview
**Coin180** is an advanced market sentiment analysis and trading signal engine designed to detect **trend reversals** using real-time visual data from [Coin360](https://coin360.com/).  

It integrates image-based heatmap sentiment quantification with multiple layered analyzers and a confidence-weighted trade signal engine — all built with **Node.js**, **TypeScript**, and **Puppeteer**.

At its core, Coin180 observes short-term and long-term market behavior to identify the moments **right after market reversals**, where momentum and direction shifts begin forming.

---

## GPU Heatmap Analyzer Setup
The replay harness can offload heatmap sentiment extraction to the GPU via a Python service that uses CuPy. Complete the following steps before running `npm run replay ... async gpu`.

1. **Install the NVIDIA CUDA Toolkit**  
   Download the toolkit that matches your CuPy wheel (currently CUDA 13.x) from the [CUDA Toolkit download page](https://developer.nvidia.com/cuda-toolkit) and install it. Confirm the toolkit is available:
   ```powershell
   nvcc --version
   ```
   If the command is not found, add `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.0\bin` (or your installed version) to the `PATH`/`CUDA_PATH` environment variables and restart your shell.

2. **Install libvips (for pyvips)**  
   The Python analyzer relies on libvips, the same image library Sharp uses. Download the latest Windows bundle from the [libvips releases](https://github.com/libvips/libvips/releases/latest) page (or install via your package manager on macOS/Linux), extract it, and add the `bin` directory containing `libvips-42.dll` to your `PATH`.

3. **Install Python dependencies**  
   From the repository root, create/activate a Python virtual environment and install the service requirements:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\activate
   pip install --upgrade pip
   pip install -r python/heatmap_service/requirements.txt
   ```

4. **Install the matching CuPy wheel**  
   Choose the wheel that matches your CUDA toolkit (examples shown for CUDA 13.x and 12.x):
   ```powershell
   # CUDA 13.x
   pip install cupy-cuda13x

   # CUDA 12.x (if you are on a 12.x toolkit instead)
   pip install cupy-cuda12x
   ```

5. **Verify the GPU backend**  
   Run the quick check below; it should report `backend: cupy`. If it prints `numpy`, the toolkit is not being detected.
   ```powershell
   python -c "import sys, pathlib; sys.path.insert(0, str(pathlib.Path('python/heatmap_service').resolve())); import gpu_heatmap_analyzer as gha; print('backend:', gha.GPU_BACKEND)"
   ```
   You can also run a replay to confirm the logs contain `"backend": "cupy"` inside each tick:
   ```powershell
   npm run replay -- trade-controller-1_<folder> test.json async gpu
   ```

The GPU path automatically falls back to CPU (NumPy) if CuPy cannot load, so these steps are optional for CPU-only environments, but recommended to benefit from faster heatmap analysis.

### Optional: Configure GPU concurrency
The replay harness spawns multiple Python workers to keep the GPU busy. Override the default concurrency (4) by setting `REPLAY_GPU_CONCURRENCY` in the `.env` file.
