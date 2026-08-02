# Video Content Analysis

This repository contains the video content analysis pipeline from our CHI ’26 paper:

**Counting How the Seconds Count: Understanding Algorithm–User Interplay in TikTok via ML-driven Analysis of Video Content** — **[Paper](https://maleehamasood.github.io/content/papers/chi-226-arxiv.pdf)** | **[Slides](https://maleehamasood.github.io/content/CHI26-TikTokTalk.pdf)** | **[Talk](https://drive.google.com/file/d/1BCLF060gFvyIetVgKeds6Rendz6tmAUI/view)**

## Overview

```text
TikTok Videos
      ↓
Extract Video + Audio Embeddings
      ↓
Generate VCA Vectors
      ↓
Downstream Analysis
```

This pipeline uses **[Video-LLaMA](https://github.com/DAMO-NLP-SG/Video-LLaMA)** to extract multimodal video and audio embeddings from TikTok videos.

## Extract Video + Audio Embeddings

### Setup

Clone Video-LLaMA and create output directories:

```bash
git clone https://github.com/DAMO-NLP-SG/Video-LLaMA.git
cd Video-LLaMA

mkdir -p embs
mkdir -p videodesc
mkdir -p vcavectors
```

### Install Conda

```bash
MINICONDA3=Miniconda3-py37_4.9.2-Linux-x86_64.sh

wget -nc https://repo.continuum.io/miniconda/$MINICONDA3 -P ~/Downloads
chmod +x ~/Downloads/$MINICONDA3
~/Downloads/$MINICONDA3 -bf

source ~/miniconda3/bin/activate base
```

### Install Dependencies

```bash
sudo apt update
sudo apt install ffmpeg
sudo apt install ubuntu-drivers-common
sudo apt install nvidia-cuda-toolkit
sudo apt install git-lfs
```

Create and activate the Video-LLaMA environment:

```bash
conda env create -f environment.yml
conda activate videollama
```

Install PyTorch:

```bash
conda install pytorch pytorch-cuda=12.1 -c pytorch -c nvidia
```

If needed, install the CUDA 11.8 PyTorch wheels explicitly:

```bash
pip install --no-cache-dir torch==2.1.2 torchvision==0.16.2 torchaudio==2.1.2 \
  --index-url https://download.pytorch.org/whl/cu118
```

### Download Video-LLaMA Checkpoints

```bash
git clone https://huggingface.co/DAMO-NLP-SG/Video-LLaMA-2-7B-Finetuned
```

### Required Code Fixes

Depending on your environment, you may need to patch `pytorchvideo`:

```bash
vim /home/maleeha2/miniconda3/envs/videollama/lib/python3.9/site-packages/pytorchvideo/transforms/augmentations.py
```

Remove `_tensor` from the imports.

### Replace Required Files

After cloning Video-LLaMA, replace the following files in the Video-LLaMA repository with the versions provided in this repository:

```text
eval_configs/video_llama_eval_withaudio.yaml
video_llama/conversation/conversation_video.py
```

Then copy the embedding extraction script into the root of the Video-LLaMA repository:

```bash
cp video2embeddings.py /path/to/Video-LLaMA/
```

After this step, `video2embeddings.py` should be located at:

```text
Video-LLaMA/video2embeddings.py
```

<!-- ## TikTok Videos

TikTok videos can be downloaded using the following URL format:

```text
https://www.tiktok.com/share/video/{video_id}
```

Replace `{video_id}` with the TikTok video ID.

Example:

```text
https://www.tiktok.com/share/video/7313716511095442693
``` -->

### Run Embedding Extraction

Run the embedding extraction script with a TikTok video ID:

```bash
python video2embeddings.py \
  --cfg-path eval_configs/video_llama_eval_withaudio.yaml \
  --model_type llama_v2 \
  --gpu-id 0 \
  --videoname {video_id}
```
Replace `{video_id}` with a 19-digit TikTok video ID.

Example:

```bash
python video2embeddings.py \
  --cfg-path eval_configs/video_llama_eval_withaudio.yaml \
  --model_type llama_v2 \
  --gpu-id 0 \
  --videoname 7636001733549870369
```

The generated embeddings are saved under:

```text
embs/
```

Video-LLaMA's response to "What is happening in the video?" is saved under:

```text
videodesc/
```

### Embedding Dimensions

For each TikTok video, the pipeline extracts both video and audio embeddings.

```text
Video embedding shape: torch.Size([1, 32, 4096])
Audio embedding shape: torch.Size([1, 8, 4096])
```

## Generate VCA Vectors

After generating the audio and video embeddings, concatenate them into a single VCA vector:

```bash
python make_vca_vector.py --videoname {video_id}
```
The output is saved as:

```text
vcavectors/vca_{video_id}.npy
```

The generated **Video Content Analysis (VCA)** vectors can be used for:

- Content clustering
- Feed diversity analysis
- Temporal behavior analysis
- Similarity search
- User-interest modeling
- Recommendation system analysis

## Citation

If you use this repository or build upon this pipeline, please cite:

```bibtex
@inproceedings{10.1145/3772318.3790311,
author = {Masood, Maleeha and Kannan, Shreya and Liu, Zikun and Vasisht, Deepak and Gupta, Indranil},
title = {Counting How the Seconds Count: Understanding TikTok Behavior via ML-driven Analysis of Video Content},
url = {https://doi.org/10.1145/3772318.3790311},
booktitle = {Proceedings of the 2026 CHI Conference on Human Factors in Computing Systems},
series = {CHI '26}
}
```