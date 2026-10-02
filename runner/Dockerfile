FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3.10 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN python3.10 -m pip install --no-cache-dir -r requirements.txt
COPY __init__.py ./
COPY agent ./agent
COPY runtime/app ./runtime/app
COPY runtime/head_cutout.py runtime/liveportrait_batch_worker.py ./runtime/
ENV AVATAR_RUNTIME_CODE_ROOT=/app/runtime
CMD ["python3.10", "-m", "agent.main"]
