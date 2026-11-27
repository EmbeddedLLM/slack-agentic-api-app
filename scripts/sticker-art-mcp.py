"""Free local MCP adapter: fixed ComfyUI sticker workflow, bounded job polling."""
import asyncio
import json
import os
import secrets
import time
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

ROOT = Path(__file__).resolve().parent.parent
ART_DIR = Path(os.environ.get("STICKER_ART_DIR", ROOT / ".runtime/sticker-art"))
COMFY_URL = os.environ.get("STICKER_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKFLOW = Path(os.environ.get("STICKER_COMFY_WORKFLOW", ROOT / "deploy/sticker-flux-klein.json"))
STYLE = ("Professional die-cut chat sticker illustration. One expressive subject, appealing proportions, "
         "strong readable silhouette, cohesive colors, polished shading and crisp details. Entire subject visible, "
         "centered with generous margin on plain white. No text, watermark, border or scenery. "
         "The application adds the cutout border and animation. Subject: ")
mcp = FastMCP("Meow sticker art", host="127.0.0.1", port=int(os.environ.get("STICKER_MCP_PORT", "8189")),
              stateless_http=True, json_response=True, log_level="WARNING")
ART_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
submit_lock = asyncio.Lock()

def save_record(job_id, record):
    target = ART_DIR / (job_id + ".json")
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(record), encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(target)

async def request(route, payload=None):
    async with httpx.AsyncClient(timeout=8, follow_redirects=False, trust_env=False) as client:
        response = await (client.get(COMFY_URL + route) if payload is None else client.post(COMFY_URL + route, json=payload))
        response.raise_for_status()
        if len(response.content) > 2 * 1024 * 1024:
            raise ValueError("ComfyUI metadata too large")
        return response.json()

@mcp.tool()
async def generate_sticker_art(prompt: str) -> str:
    """Generate polished sticker artwork from a short visual description using local ComfyUI. Returns job_id immediately. Call sticker_art_status with that job_id until ready; do not submit duplicates. Once ready, call the Slack create_sticker function with source_image.id=image_id, background=auto, desired motion, and frames=null to attach the animated GIF. This tool itself does not post to Slack."""
    if not prompt.strip() or len(prompt) > 1000:
        return json.dumps({"ok": False, "error": "Describe one sticker in 1–1000 characters."})
    async with submit_lock:
        try:
            queue = await request("/queue")
            if len(queue.get("queue_running", [])) + len(queue.get("queue_pending", [])) >= 3:
                return json.dumps({"ok": False, "error": "Artwork queue is full. Try again after current jobs finish."})
            workflow = json.loads(WORKFLOW.read_text())
            workflow["6"]["inputs"]["text"] = STYLE + prompt
            workflow["73"]["inputs"]["noise_seed"] = secrets.randbits(32)
            queued = await request("/prompt", {"prompt": workflow, "client_id": "meow-sticker-mcp"})
            if not queued.get("prompt_id") or queued.get("node_errors"):
                raise ValueError("Workflow rejected")
            job_id = secrets.token_hex(16)
            save_record(job_id, {"prompt_id": queued["prompt_id"], "created_at": time.time()})
            return json.dumps({"ok": True, "status": "queued", "job_id": job_id,
                               "next": "Call sticker_art_status with this job_id. CPU generation can take several minutes."})
        except Exception:
            return json.dumps({"ok": False, "error": "ComfyUI is unavailable or rejected the workflow. Check the local sticker-art service."})

@mcp.tool()
async def sticker_art_status(job_id: str) -> str:
    """Wait up to 50 seconds for a sticker artwork job. If pending, call this again with the same job_id. If ready, use its image_id in create_sticker to produce the requested GIF; do not invent an image ID or file URL."""
    try:
        return await asyncio.wait_for(read_status(job_id), timeout=50)
    except asyncio.TimeoutError:
        return json.dumps({"ok": True, "status": "pending", "job_id": job_id, "next": "Call sticker_art_status again with this same job_id."})

async def read_status(job_id: str) -> str:
    if len(job_id) != 32 or any(c not in "0123456789abcdef" for c in job_id):
        return json.dumps({"ok": False, "error": "Invalid job ID."})
    try:
        record = json.loads((ART_DIR / (job_id + ".json")).read_text())
        if time.time() - record["created_at"] > 3600:
            return json.dumps({"ok": False, "error": "Artwork job expired. Create a new one."})
        image_id = "art_" + job_id
        if (ART_DIR / (image_id + ".png")).is_file():
            return json.dumps({"ok": True, "status": "ready", "image_id": image_id})
        deadline = time.monotonic() + 42
        while time.monotonic() < deadline:
            history = (await request("/history/" + record["prompt_id"])).get(record["prompt_id"], {})
            if history.get("status", {}).get("status_str") == "error":
                return json.dumps({"ok": False, "error": "Artwork generation failed. Check ComfyUI logs."})
            images = history.get("outputs", {}).get("9", {}).get("images", [])
            if images:
                image = images[0]
                async with httpx.AsyncClient(timeout=8, follow_redirects=False, trust_env=False) as client:
                    async with client.stream("GET", COMFY_URL + "/view", params={k: image.get(k, "") for k in ["filename", "subfolder", "type"]}) as response:
                        response.raise_for_status()
                        parts = []; size = 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > 20 * 1024 * 1024:
                                raise ValueError("Artwork too large")
                            parts.append(chunk)
                data = b"".join(parts)
                if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Artwork must be PNG")
                output = ART_DIR / (image_id + ".png")
                output.write_bytes(data); output.chmod(0o600)
                return json.dumps({"ok": True, "status": "ready", "image_id": image_id, "bytes": len(data)})
            await asyncio.sleep(1)
        return json.dumps({"ok": True, "status": "pending", "job_id": job_id, "next": "Call sticker_art_status again with this same job_id."})
    except Exception:
        return json.dumps({"ok": False, "error": "Could not read this artwork job. Check its ID and the local service."})

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
