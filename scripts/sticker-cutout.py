"""CPU-only subject segmentation; binary image in on stdin, transparent PNG out."""
import io
import os
import sys
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("OMP_NUM_THREADS", "4")

def main():
    model_home = Path(os.environ["U2NET_HOME"])
    if not (model_home / "isnet-general-use.onnx").is_file():
        raise RuntimeError("Install the cutout model with npm run sticker:install first.")
    from PIL import Image, ImageOps
    from rembg import new_session, remove
    Image.MAX_IMAGE_PIXELS = 16_000_000
    data = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024:
        raise ValueError("Image too large")
    image = Image.open(io.BytesIO(data))
    if image.width * image.height > 16_000_000:
        raise ValueError("Image exceeds the pixel limit")
    image = ImageOps.exif_transpose(image).convert("RGBA")
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    session = new_session("isnet-general-use", providers=["CPUExecutionProvider"])
    result = remove(image, session=session, post_process_mask=True)
    result.save(sys.stdout.buffer, format="PNG")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Keep model paths, input content and environment values out of tool errors.
        print("Subject segmentation failed. Check the local cutout installation and input image.", file=sys.stderr)
        sys.exit(1)
