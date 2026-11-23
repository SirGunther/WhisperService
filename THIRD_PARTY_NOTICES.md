# Third-party notices

## whisper.cpp

- Source: https://github.com/ggml-org/whisper.cpp
- Pinned release: `v1.9.1`
- Pinned commit: `f049fff95a089aa9969deb009cdd4892b3e74916`
- License: MIT

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## ggml Whisper models

Each model is provisioned on request (`npm run setup -- --model <id>`) into the user's local application-data directory, verified by SHA-256, and not redistributed by this repository. The provisioning source for every file is `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`.

| Model | File | SHA-256 |
| --- | --- | --- |
| `tiny.en` | `ggml-tiny.en.bin` | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |
| `base.en` | `ggml-base.en.bin` | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| `small.en` | `ggml-small.en.bin` | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
| `medium.en` | `ggml-medium.en.bin` | `cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356` |
| `large-v1` | `ggml-large-v1.bin` | `7d99f41a10525d0206bddadd86760181fa920438b6b33237e3118ff6c83bb53d` |
| `large-v2` | `ggml-large-v2.bin` | `9a423fe4d40c82774b6af34115b8b935f34152246eb19e80e376071d3f999487` |
| `large-v3` | `ggml-large-v3.bin` | `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2` |
| `large-v3-turbo` | `ggml-large-v3-turbo.bin` | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |

## Vulkan SDK (build time only)

A GPU build compiles ggml's Vulkan backend against the LunarG Vulkan SDK's headers, SPIR-V headers and `glslc` shader compiler, which the user installs separately. At run time the worker uses only `vulkan-1.dll` from the graphics driver. Nothing from the SDK is redistributed by this repository.

## Node packages

Runtime package identities and integrity hashes are recorded in `package-lock.json`. Their license metadata is available from `npm query .license` after installation.
