import os
import sys
import socket
import time
import logging
from pathlib import Path

# ==============================================================================
# 1. ĐỌC FILE .ENV VÀ KIỂM TRA GEMINI_API_KEY
# ==============================================================================
print("=" * 60)
print("BƯỚC 1: KIỂM TRA VÀ NẠP BIẾN MÔI TRƯỜNG TỪ .env")
print("=" * 60)

env_path = Path(".env")
api_key = os.getenv("GEMINI_API_KEY", "")

if not api_key and env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                val = line.split("=", 1)[1].strip()
                # Gỡ bỏ dấu nháy kép hoặc đơn nếu có
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                api_key = val
                os.environ["GEMINI_API_KEY"] = api_key
                break

if not api_key:
    print("❌ LỖI: Không tìm thấy GEMINI_API_KEY trong file .env hoặc biến môi trường!")
    sys.exit(1)
else:
    masked_key = f"{'*' * (len(api_key) - 4)}{api_key[-4:]}" if len(api_key) >= 4 else "****"
    print(f"✅ Đã tìm thấy GEMINI_API_KEY:")
    print(f"   - Độ dài: {len(api_key)} ký tự")
    print(f"   - 4 ký tự cuối: ...{api_key[-4:]}")
    print(f"   - Masked: {masked_key}")


# ==============================================================================
# 2. KIỂM TRA KẾT NỐI MẠNG TẦNG SOCKET (TCP PORT 443)
# ==============================================================================
print("\n" + "=" * 60)
print("BƯỚC 2: KIỂM TRA KẾT NỐI TCP SOCKET ĐẾN GOOGLE APIS")
print("=" * 60)

host = "generativelanguage.googleapis.com"
port = 443
socket_timeout = 5.0

print(f"📡 Đang thử kết nối TCP tới {host}:{port} (timeout={socket_timeout}s)...")
start_time = time.time()
try:
    sock = socket.create_connection((host, port), timeout=socket_timeout)
    elapsed = time.time() - start_time
    sock.close()
    print(f"✅ Kết nối TCP thành công sau {elapsed:.3f}s. Mạng, DNS và Firewall bình thường.")
except socket.gaierror as e:
    print(f"❌ LỖI DNS: Không thể phân giải tên miền {host}: {e}")
except socket.timeout:
    print(f"❌ TIMEOUT: Không thể kết nối tới {host}:{port} trong vòng {socket_timeout}s (nghi ngờ Firewall / ISP chặn hoặc cần VPN / Proxy).")
except Exception as e:
    print(f"❌ LỖI KẾT NỐI TẦNG MẠNG: {type(e).__name__}: {e}")


# ==============================================================================
# 3. CẤU HÌNH VERBOSE LOGGING CHO HTTP (HTTPX, HTTPCORE, URLLIB3)
# ==============================================================================
print("\n" + "=" * 60)
print("BƯỚC 3: BẬT CHẾ ĐỘ DEBUG LOG CHO HTTP/SSL")
print("=" * 60)

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S"
)
for lib in ("httpx", "httpcore", "urllib3", "google"):
    logging.getLogger(lib).setLevel(logging.DEBUG)

print("✅ Đã kích hoạt DEBUG log cho httpx, httpcore, urllib3.")


# ==============================================================================
# 4. GỬI REQUEST TỐI GIẢN TỚI GOOGLE GENAI SDK (TIMEOUT 10 GIÂY)
# ==============================================================================
print("\n" + "=" * 60)
print("BƯỚC 4: GỬI REQUEST TỐI GIẢN VỚI TIMEOUT = 10000ms (10s)")
print("=" * 60)

from google import genai
from google.genai import types

test_model = "gemini-3.8-flash"
request_success = False

try:
    print(f"🚀 Khởi tạo GenAI Client với timeout 10000ms (10 giây)...")
    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=10000)
    )

    print(f"📤 Đang gửi nội dung 'ping' tới model '{test_model}'...")
    response = client.models.generate_content(
        model=test_model,
        contents="ping",
    )
    print(f"✅ Phản hồi thành công từ {test_model}!")
    print(f"   Nội dung phản hồi: {response.text}")
    request_success = True

except Exception as e:
    print(f"\n❌ LỖI KHI GỌI MODEL '{test_model}':")
    print(f"   Loại ngoại lệ: {type(e).__name__}")
    print(f"   Chi tiết lỗi: {e}")


# ==============================================================================
# 5. LIỆT KÊ DANH SÁCH MODEL KHẢ DỤNG NẾU REQUEST TRÊN THẤT BẠI
# ==============================================================================
if not request_success:
    print("\n" + "=" * 60)
    print("BƯỚC 5: TRUY VẤN DANH SÁCH MODEL KHẢ DỤNG (client.models.list())")
    print("=" * 60)
    print("🔍 Đang gọi client.models.list() để kiểm tra các model được hỗ trợ...")

    try:
        models_pager = client.models.list(config={"page_size": 100})
        available_models = []
        for m in models_pager:
            name = getattr(m, "name", str(m))
            display_name = getattr(m, "display_name", "")
            available_models.append((name, display_name))

        if available_models:
            print(f"✅ Tìm thấy {len(available_models)} models khả dụng:")
            # Lọc hiển thị các model gemini nổi bật
            flash_models = [m for m in available_models if "flash" in m[0].lower()]
            print(f"\n--- Các model Flash tìm thấy ({len(flash_models)}) ---")
            for name, dname in flash_models:
                print(f"   • {name:40} | {dname}")

            print(f"\n--- Danh sách toàn bộ models ({len(available_models)}) ---")
            for name, dname in available_models[:15]:
                print(f"   • {name:40} | {dname}")
            if len(available_models) > 15:
                print(f"   ... và {len(available_models) - 15} models khác.")
        else:
            print("⚠️ API trả về danh sách rỗng hoặc không có quyền truy cập model nào.")

    except Exception as e:
        print(f"❌ LỖI KHI GỌI client.models.list():")
        print(f"   Loại ngoại lệ: {type(e).__name__}")
        print(f"   Chi tiết lỗi: {e}")

print("\n" + "=" * 60)
print("KẾT THÚC CHẨN ĐOÁN")
print("=" * 60)

