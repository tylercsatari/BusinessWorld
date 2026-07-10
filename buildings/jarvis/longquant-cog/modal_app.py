"""Scale-to-zero Modal host for the two finalized Long Quant LoRAs."""

import hashlib
import hmac
import json
import os

import modal

from worker_core import LongQuantEngine


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


def _download_base():
    from huggingface_hub import snapshot_download

    snapshot_download(BASE_MODEL, revision=BASE_REVISION, local_dir=BASE_DIR)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("huggingface_hub==0.36.0", "hf_xet")
    .add_local_python_source("worker_core", copy=True)
    .run_function(_download_base)
    .pip_install(
        "torch==2.5.1",
        "transformers==4.53.2",
        "peft==0.16.0",
        "accelerate==1.1.1",
        "boto3==1.35.0",
        "fastapi[standard]==0.115.5",
    )
)

app = modal.App(APP_NAME)
r2_secret = modal.Secret.from_name("hook-r2")


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


@app.cls(
    image=image,
    gpu="H100",
    secrets=[r2_secret],
    scaledown_window=300,
    timeout=1800,
    max_containers=1,
)
class Model:
    @modal.enter()
    def load(self):
        _download_adapters()
        self.engine = LongQuantEngine()
        self.engine.setup(BASE_DIR, ADAPTER_DIRS, tensor_parallel_size=1, backend="transformers")

    @modal.fastapi_endpoint(method="POST")
    def predict(self, data: dict):
        expected = hashlib.sha256(
            (os.environ["R2_SECRET_ACCESS_KEY"] + ":longquant-worker").encode("utf-8")
        ).hexdigest()
        supplied = str(data.get("token") or "")
        if not hmac.compare_digest(supplied, expected):
            return {"error": "unauthorized"}

        source = data.get("input") if isinstance(data.get("input"), dict) else data
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
        return self.engine.predict(**payload)
