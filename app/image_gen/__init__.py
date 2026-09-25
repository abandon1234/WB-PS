# -*- coding: utf-8 -*-
"""图片生成模块。

独立于文字处理模块：自带页面路由、接口路由与配置存储，
通过 OpenAI 兼容中转站调用 gpt-image-2 生成图片。
"""
from . import client, config  # noqa: F401

__all__ = ["client", "config"]
