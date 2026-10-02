# Avatar Runner

Runner là agent chạy trên máy inference và kết nối outbound đến Avatar Master bằng WSS.

## Layout độc lập

- `agent/`: agent WSS, enrollment, heartbeat và nhận assignment từ Master.
- `runtime/`: LivePortrait runtime Python và pipeline preprocess/decode/export.
- `setup-liveportrait-*.sh`: cài model và môi trường LivePortrait cho máy runner.
- `install-*.sh` / `install-windows.ps1`: cài runner native trên máy đích.
- `.runtime/`: dữ liệu tạm và log của runner khi chạy local; không phải source code.

Khi triển khai Runner, chỉ cần dùng repository/thư mục này cùng LivePortrait model
hoặc cho installer tải model. Runner không cần `master/` hay bộ benchmark nội bộ.

## Ubuntu/macOS

```bash
AVATAR_MASTER_URL=wss://avatar.example.com/runner/ws \
AVATAR_RUNNER_ENROLL_CODE=ABCD1234 \
LIVEPORTRAIT_ROOT="$HOME/.cache/avatar-studio/LivePortrait" \
bash install.sh
```

Sau enrollment, token được lưu trong `~/.avatar-runner/credentials.json`; service native tự khởi động lại và reconnect.

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 `
  -MasterUrl wss://avatar.example.com/runner/ws `
  -EnrollmentCode ABCD1234
```

Windows cần Python, ffmpeg, driver GPU và LivePortrait runtime tương thích.
