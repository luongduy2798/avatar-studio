FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3.10 python3-pip ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN python3.10 -m pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY head_cutout.py liveportrait_batch_worker.py ./
CMD ["python3.10", "-m", "app.main"]
