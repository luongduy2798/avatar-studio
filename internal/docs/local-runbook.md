# Chạy local/internal từ đầu đến cuối

Tài liệu này dùng cho benchmark trên một máy macOS hoặc Ubuntu. Chế độ local
không dùng PM2 và không gọi AWS. Queue, job, input và output được lưu trong
runner/.runtime.

## 1. Chuẩn bị máy

### macOS

~~~bash
brew install node python@3.10 ffmpeg git
export PATH="$(brew --prefix python@3.10)/libexec/bin:$PATH"
node --version
python3 --version
ffmpeg -version
~~~

### Ubuntu

~~~bash
sudo apt-get update
sudo apt-get install -y git curl ffmpeg build-essential python3 python3-venv
node --version
python3 --version
ffmpeg -version
~~~

Máy Ubuntu có NVIDIA cần kiểm tra thêm:

~~~bash
nvidia-smi
~~~

Nếu nvidia-smi không chạy, sửa driver trước khi benchmark CUDA.

## 2. Lấy source

Nếu source chưa có trên máy:

~~~bash
cd ~/Desktop
git clone <AVATAR_STUDIO_REPOSITORY_URL> avatar-studio
cd avatar-studio
~~~

Nếu source đã có:

~~~bash
cd /path/to/avatar-studio
~~~

## 3. Cài dependencies và model

Chạy một lần hoặc chạy lại khi dependencies thay đổi:

~~~bash
cd /path/to/avatar-studio
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
make -f internal/Makefile setup
~~~

Lệnh này cài Master, Admin React/Vite, benchmark web client, runner Python
venv, LivePortrait và các model phụ trợ. Model được lưu ngoài repository tại:

~~~text
~/.cache/avatar-studio/LivePortrait
~~~

## 4. Kiểm tra runtime

~~~bash
cd /path/to/avatar-studio
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
make -f internal/Makefile doctor
~~~

Tiếp tục khi doctor báo LivePortrait runtime, weights và Python environment
đã sẵn sàng.

## 5. Chạy local stack

~~~bash
cd /path/to/avatar-studio
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
make -f internal/Makefile run
~~~

Mỗi lần chạy, stack sẽ xóa trạng thái local cũ trong runner/.runtime rồi khởi
động:

~~~text
Benchmark web: http://127.0.0.1:5173
Master API:     http://127.0.0.1:8000
Admin:          http://127.0.0.1:8000/admin
~~~

Mở benchmark web tại http://127.0.0.1:5173, upload ảnh và chạy Batch benchmark
hoặc Staggered load test.

Dừng toàn bộ stack bằng:

~~~text
Ctrl+C
~~~

## 6. Chọn cấu hình benchmark

Cấu hình mặc định dùng chung cho macOS và Ubuntu:

~~~bash
AVATAR_ONNX_DEVICE=cpu \
AVATAR_ONNX_THREADS=16 \
AVATAR_DECODE_BATCH_SIZE=24 \
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
make -f internal/Makefile run
~~~

Trên Ubuntu NVIDIA, có thể thử CUDA sau khi doctor báo CUDA available:

~~~bash
AVATAR_ONNX_DEVICE=cuda \
AVATAR_ONNX_THREADS=16 \
AVATAR_DECODE_BATCH_SIZE=24 \
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
make -f internal/Makefile run
~~~

## 7. Nếu không dùng make

Ubuntu:

~~~bash
cd /path/to/avatar-studio
bash internal/scripts/setup-ubuntu.sh
AVATAR_SKIP_SETUP=1 bash internal/scripts/dev-stack.sh
~~~

macOS:

~~~bash
cd /path/to/avatar-studio
npm --prefix master install --no-audit --no-fund --package-lock=false
npm --prefix master run setup:admin
npm --prefix master run build:admin
npm --prefix internal/web-client install --no-audit --no-fund --package-lock=false
PYTHON_BIN="$(command -v python3.10 || command -v python3)" \
  bash internal/scripts/dev-stack.sh
~~~

## 8. SSH tunnel tới Ubuntu server

Chạy trên Mac:

~~~bash
ssh -N \
  -L 5173:127.0.0.1:5173 \
  -L 8000:127.0.0.1:8000 \
  user@server
~~~

Sau đó mở trên Mac:

~~~text
http://127.0.0.1:5173
~~~

Không cần AWS credentials trong local mode. Internal dùng local file adapters
thay cho S3, SQS và DynamoDB.

