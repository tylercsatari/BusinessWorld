"""
Adapted from: https://github.com/Vision-CAIR/MiniGPT-4/blob/main/demo.py
"""

import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="torchvision.transforms._functional_video")
warnings.filterwarnings("ignore", category=UserWarning, module="torchvision.transforms._transforms_video")

import argparse
import os
import random

import numpy as np
import torch
import torch.backends.cudnn as cudnn
import gradio as gr

from video_llama.common.config import Config
from video_llama.common.dist_utils import get_rank
from video_llama.common.registry import registry
from video_llama.conversation.conversation_video import Chat, Conversation, default_conversation,SeparatorStyle,conv_llava_llama_2
import decord
decord.bridge.set_bridge('torch')

from video_llama.datasets.builders import *
from video_llama.models import *
from video_llama.processors import *
from video_llama.runners import *
from video_llama.tasks import *

def parse_args():
    parser = argparse.ArgumentParser(description="Demo")
    parser.add_argument("--cfg-path", default='eval_configs/video_llama_eval_withaudio.yaml', help="path to configuration file.")
    parser.add_argument("--gpu-id", type=int, default=0, help="specify the gpu to load the model.")
    parser.add_argument("--model_type", type=str, default='vicuna', help="The type of LLM")
    parser.add_argument(
        "--options",
        nargs="+",
        help="override some settings in the used config, the key-value pair "
        "in xxx=yyy format will be merged into config file (deprecate), "
        "change to --cfg-options instead.",
    )
    parser.add_argument("--videoname", type=str, default='7313716511095442693', help="19 Digit TikTok Video ID")
    args = parser.parse_args()
    return args

def setup_seeds(config):
    seed = config.run_cfg.seed + get_rank()

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)

    cudnn.benchmark = False
    cudnn.deterministic = True

args = parse_args()

if "audio_" + args.videoname + ".pth" not in os.listdir("embs"):
    print('Initializing Chat')
    cfg = Config(args)

    model_config = cfg.model_cfg
    model_config.device_8bit = args.gpu_id
    model_cls = registry.get_model_class(model_config.arch)
    model = model_cls.from_config(model_config).to('cuda:{}'.format(args.gpu_id))
    model.eval()
    vis_processor_cfg = cfg.datasets_cfg.webvid.vis_processor.train
    vis_processor = registry.get_processor_class(vis_processor_cfg.name).from_config(vis_processor_cfg)
    chat = Chat(model, vis_processor, device='cuda:{}'.format(args.gpu_id))
    print('Initialization Finished')

    with gr.Blocks() as demo:
        video = gr.Video()
        chat_state = gr.State()
        img_list = gr.State()
        chat_state = conv_llava_llama_2.copy(); videoname = args.videoname; command = f'yt-dlp --no-warnings --extractor-args "tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_info=7355728856979392262" "https://www.tiktok.com/@/video/{videoname}" -o "{videoname}.mp4"'

        print(f"Downloading Video {args.videoname} Temporarily")
        os.system(command)

        video = args.videoname + ".mp4"
        gr_video = video
        chat_state.system =  ""
        img_list = []
        llm_message = chat.upload_video(gr_video, chat_state, img_list)

        user_message = "What is happening in the video?"
        chat.ask(user_message, chat_state)

        llm_message = chat.answer(conv=chat_state, img_list=img_list, max_new_tokens=300, max_length=20000)[0]

        with open("videodesc/" + args.videoname + '.txt', 'w') as file:
            file.write(llm_message)

        os.system("rm " + args.videoname + ".mp4")
        print("Deleted Video")