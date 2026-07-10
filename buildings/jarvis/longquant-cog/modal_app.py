"""Scale-to-zero Modal host for the two finalized Long Quant LoRAs."""

import hashlib
import hmac
import json
import os
import time

import modal


APP_NAME = "longquant-trained-worker"
BASE_MODEL = "Qwen/Qwen3-30B-A3B"
BASE_REVISION = "ad44e777bcd18fa416d9da3bd8f70d33ebb85d39"
BASE_DIR = "/models/qwen3-30b-a3b"
ADAPTER_DIRS = {
    "idea": "/adapters/idea_long_r26",
    "thumb": "/adapters/thumb_b10",
}
ADAPTER_HASHES = {
    "idea": "56f3a4c46b2fe38aec58e68b06b307af03c10618e2d6d8e4bd423ee8a4201cf2",
    "thumb": "2152f0e8fd27311da1820c9e7923a78406d402b58cc63a1640ca65a1dccc7799",
}

app = modal.App(APP_NAME)
r2_secret = modal.Secret.from_name("hook-r2")


def _download_base():
    from huggingface_hub import snapshot_download

    snapshot_download(BASE_MODEL, revision=BASE_REVISION, local_dir=BASE_DIR)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_adapters():
    import boto3

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    bucket = os.environ["R2_BUCKET_NAME"]
    for task, adapter_dir in ADAPTER_DIRS.items():
        os.makedirs(adapter_dir, exist_ok=True)
        model_name = os.path.basename(adapter_dir)
        response = s3.list_objects_v2(Bucket=bucket, Prefix=f"hooks/models/{model_name}/")
        for item in response.get("Contents", []):
            name = item["Key"].rsplit("/", 1)[-1]
            if name:
                s3.download_file(bucket, item["Key"], os.path.join(adapter_dir, name))

        weights = os.path.join(adapter_dir, "adapter_model.safetensors")
        if _sha256(weights) != ADAPTER_HASHES[task]:
            raise RuntimeError(f"{model_name} failed its finalized adapter hash check")
        config_path = os.path.join(adapter_dir, "adapter_config.json")
        with open(config_path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
        config["base_model_name_or_path"] = BASE_MODEL
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(config, handle)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("huggingface_hub==0.36.0", "hf_xet")
    .run_function(_download_base)
    .pip_install(
        "torch==2.5.1",
        "transformers==4.53.2",
        "peft==0.19.1",
        "accelerate==1.1.1",
        "boto3==1.35.0",
        "fastapi[standard]==0.115.5",
    )
    .run_function(_download_adapters, secrets=[r2_secret])
    .env({
        "HF_ENABLE_PARALLEL_LOADING": "true",
        "HF_PARALLEL_LOADING_WORKERS": "4",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    # Keep source last so inference-code edits never invalidate the 61 GB weight layers.
    .add_local_python_source("worker_core", copy=True)
)


@app.cls(
    image=image,
    gpu=["H100", "A100-80GB"],
    secrets=[r2_secret],
    min_containers=0,
    buffer_containers=0,
    scaledown_window=45,
    timeout=1800,
    startup_timeout=600,
    max_containers=1,
)
class Model:
    @modal.enter()
    def load(self):
        from worker_core import LongQuantEngine

        started = time.monotonic()
        self.engine = LongQuantEngine()
        self.engine.setup(BASE_DIR, ADAPTER_DIRS, tensor_parallel_size=1, backend="transformers")
        self.startup_seconds = round(time.monotonic() - started, 3)
        self.gpu_name = self.engine.torch.cuda.get_device_name(0)
        print(
            f"[longquant] finalized models ready in {self.startup_seconds}s on {self.gpu_name}",
            flush=True,
        )

    @modal.fastapi_endpoint(method="POST")
    def predict(self, data: dict):
        expected = hashlib.sha256(
            (os.environ["R2_SECRET_ACCESS_KEY"] + ":longquant-worker").encode("utf-8")
        ).hexdigest()
        supplied = str(data.get("token") or "")
        if not hmac.compare_digest(supplied, expected):
            return {"error": "unauthorized"}

        source = data.get("input") if isinstance(data.get("input"), dict) else data
        if source.get("task") == "health":
            return {
                "ready": True,
                "models": ["idea_long_r26", "thumb_b10"],
                "base": BASE_REVISION,
                "startup_seconds": self.startup_seconds,
                "gpu": self.gpu_name,
            }
        allowed = {
            "task",
            "premise",
            "idea",
            "context",
            "instruction",
            "avoid_json",
            "semantic_ring_json",
            "invent",
            "attempt",
            "count",
            "seed",
        }
        payload = {key: value for key, value in source.items() if key in allowed}
        result = self.engine.predict(**payload)
        result["worker_startup_seconds"] = self.startup_seconds
        result["worker_gpu"] = self.gpu_name
        return result
