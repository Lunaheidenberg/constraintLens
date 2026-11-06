"""
parser.py
---------
Nhận mô tả dự án dạng văn bản tự do từ người dùng, gọi Gemini Flash
để trích xuất và cấu trúc hóa dữ liệu, trả về đối tượng SchedulingIR
đã được Pydantic validate.

Quy tắc tuân thủ (architecture.md):
  - Mọi dữ liệu vào/ra tuân theo models.py – tuyệt đối không sửa models.py.
  - Stateless: không lưu DB, không side-effect ngoài API call.
  - Validation First: file này chỉ parse; validation DAG nằm ở validator.py.

SDK: google-genai (mới) thay cho google-generativeai (deprecated).

Giao tiếp công khai (Interface Contract):
  parse_kanban_prompt(user_text: str, api_key: str) -> SchedulingIR
"""

import json
import os
import re
from typing import Any

from google import genai
from google.genai import types
from google.genai.errors import APIError
from pydantic import ValidationError

from models import SchedulingIR


# ---------------------------------------------------------------------------
# Hằng số cấu hình
# ---------------------------------------------------------------------------

# Model ưu tiên theo thứ tự: thử model 1 trước, nếu không khả dụng thì fallback
_PRIMARY_MODEL = "gemini-3.8-flash"
_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"]
_TIMEOUT_MS = 20_000  # 20 giây – đủ cho Streamlit không bị treo giao diện

# Các mã lỗi HTTP đáng để thử fallback ngay (không retry)
_FALLBACK_STATUS = {"503", "504"}

# Các mã lỗi đáng để retry trên cùng model (rate-limit ngắn hạn)
_RETRY_STATUS = {"429"}


# ---------------------------------------------------------------------------
# Hàm nội bộ: làm sạch phản hồi JSON từ LLM
# ---------------------------------------------------------------------------

def _strip_markdown_json(text: str) -> str:
    """Loại bỏ block ```json ... ``` nếu LLM bọc JSON trong markdown."""
    text = text.strip()
    if text.startswith("```"):
        # Xóa dòng đầu (```json hoặc ```) và dòng cuối (```)
        lines = text.splitlines()
        # Bỏ dòng đầu và dòng cuối nếu là ```
        start = 1 if lines[0].startswith("```") else 0
        end = len(lines) - 1 if lines[-1].strip() == "```" else len(lines)
        text = "\n".join(lines[start:end]).strip()
    return text


# ---------------------------------------------------------------------------
# Hàm nội bộ: suy luận wip_limits từ văn bản thô (fallback khi schema bị giới hạn)
# ---------------------------------------------------------------------------

def _infer_wip_limits(user_text: str, stages: list[str]) -> dict[str, int]:
    """
    Trích xuất giới hạn WIP từ văn bản bằng regex.
    Dùng như lớp bảo vệ khi Google Developer API chưa hỗ trợ
    additionalProperties trong response_schema (gây ra dict rỗng {}).
    """
    inferred: dict[str, int] = {}
    for stage in stages:
        p_forward = rf"{re.escape(stage)}[^\n\.]*?(?:tối đa|giới hạn|WIP\s*[=:])\s*(\d+)"
        p_backward = rf"(?:tối đa|giới hạn|WIP\s*[=:])\s*(\d+)[^\n\.]*?{re.escape(stage)}"
        match = re.search(p_forward, user_text, re.IGNORECASE) or \
                re.search(p_backward, user_text, re.IGNORECASE)
        if match:
            inferred[stage] = int(match.group(1))
    return inferred


# ---------------------------------------------------------------------------
# Hàm nội bộ: xây dựng GenAI response schema (loại bỏ additionalProperties)
# ---------------------------------------------------------------------------

_ALLOWED_SCHEMA_KEYS = {
    "type", "format", "description", "nullable", "enum",
    "items", "properties", "required",
    "max_items", "maxItems", "min_items", "minItems",
    "any_of", "anyOf",
    "property_ordering", "propertyOrdering",
}


def _resolve_schema(
    schema: dict[str, Any],
    defs: dict[str, Any],
    *,
    is_property_map: bool = False,
) -> dict[str, Any]:
    """
    Đệ quy giải quyết $ref và chỉ giữ lại các key mà GenAI Developer API hỗ trợ.
    additionalProperties bị bỏ qua vì API không hỗ trợ trong chế độ Developer.
    """
    if "$ref" in schema:
        ref_name = schema["$ref"].split("/")[-1]
        return _resolve_schema(defs.get(ref_name, {}), defs)

    result: dict[str, Any] = {}
    for key, value in schema.items():
        if not is_property_map and key not in _ALLOWED_SCHEMA_KEYS:
            continue  # bỏ qua additionalProperties, title, default, ...

        if key == "properties" and isinstance(value, dict):
            result[key] = _resolve_schema(value, defs, is_property_map=True)
        elif isinstance(value, dict):
            result[key] = _resolve_schema(value, defs)
        elif isinstance(value, list):
            result[key] = [
                _resolve_schema(v, defs) if isinstance(v, dict) else v
                for v in value
            ]
        else:
            result[key] = value

    return result


def _build_genai_schema(model_class: type) -> dict[str, Any]:
    """Chuyển Pydantic v2 model class sang dict tương thích với GenAI proto Schema."""
    full_schema = model_class.model_json_schema()
    defs = full_schema.get("$defs", {})
    return _resolve_schema(full_schema, defs)


# ---------------------------------------------------------------------------
# Hàm chính – Interface Contract (KHÔNG thay đổi chữ ký)
# ---------------------------------------------------------------------------

def parse_kanban_prompt(user_text: str, api_key: str) -> SchedulingIR:
    """
    Phân tích mô tả dự án bằng Gemini Flash và trả về SchedulingIR.

    Parameters
    ----------
    user_text : str
        Đoạn mô tả dự án bằng ngôn ngữ tự nhiên từ người dùng.
    api_key : str
        Google Generative AI API key.

    Returns
    -------
    SchedulingIR
        Đối tượng IR đã được Pydantic validate, sẵn sàng đưa vào validator/solver.

    Raises
    ------
    APIError
        Khi mọi model và fallback đều thất bại do lỗi kết nối/server.
    ValidationError
        Khi LLM trả về JSON không khớp với cấu trúc SchedulingIR.
    """

    # 1. Khởi tạo client với timeout cứng để không treo Streamlit
    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=_TIMEOUT_MS),
    )

    # 2. System Prompt – 5 quy tắc nghiệp vụ bắt buộc
    system_prompt = (
        "Bạn là chuyên gia phân tích dự án Kanban. Nhiệm vụ: đọc mô tả dự án và trả về "
        "một đối tượng JSON hợp lệ theo schema SchedulingIR. Tuân thủ nghiêm ngặt 5 quy tắc sau:\n\n"

        "QUY TẮC 1 – Đồng bộ Tên Cột (Case-Sensitive):\n"
        "  Giá trị `kanban_stage` của mọi task và key trong `kanban_config.wip_limits` "
        "BẮT BUỘC khớp chính xác ký tự (kể cả chữ hoa/thường) với các phần tử trong "
        "`kanban_config.stages`. Ví dụ: nếu stages = [\"Design\", \"Backend\"], "
        "thì kanban_stage phải là \"Design\" hoặc \"Backend\", không được viết \"design\" hay \"backend\".\n\n"

        "QUY TẮC 2 – Bẻ nhỏ luồng Kanban (Stage Decomposition):\n"
        "  Mỗi task chỉ thuộc về DUY NHẤT MỘT cột Kanban. "
        "Nếu một tính năng lớn đi qua nhiều cột (Design → Backend → Review), "
        "hãy tạo nhiều task riêng lẻ nối tiếp nhau và gắn dependencies tuần tự.\n\n"

        "QUY TẮC 3 – ID & Dependencies:\n"
        "  - Mã id đặt tuần tự: T1, T2, T3, ...\n"
        "  - Trường `dependencies` chỉ chứa id thực sự tồn tại trong danh sách tasks.\n"
        "  - Nếu không có phụ thuộc: trả `[]` (mảng rỗng), KHÔNG dùng null.\n\n"

        "QUY TẮC 4 – Điền khuyết hợp lý:\n"
        "  - Nếu không rõ `duration`: ước lượng số nguyên dương >= 1 (đơn vị: ngày).\n"
        "  - Nếu không rõ `wip_limits` cho một cột: suy luận 1 <= wip_limit <= team_capacity.\n"
        "  - Nếu không rõ `team_capacity`: ước lượng >= 1.\n\n"

        "QUY TẮC 5 – Định dạng đầu ra:\n"
        "  Chỉ trả về chuỗi JSON thuần túy (không có markdown, không có giải thích thêm). "
        "Cấu trúc bắt buộc: {project_name, team_capacity, kanban_config: {stages, wip_limits}, tasks: []}."
    )

    # 3. Xây dựng GenAI-compatible schema và GenerateContentConfig
    genai_schema = _build_genai_schema(SchedulingIR)
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=genai_schema,
        system_instruction=system_prompt,
    )

    # 4. Gọi API: thử primary model, fallback tự động nếu gặp lỗi server
    models_to_try = [_PRIMARY_MODEL] + _FALLBACK_MODELS
    last_error: Exception | None = None

    for current_model in models_to_try:
        try:
            response = client.models.generate_content(
                model=current_model,
                contents=user_text,
                config=config,
            )
            # Thành công → thoát khỏi vòng lặp
            break

        except APIError as e:
            last_error = e
            error_str = str(e)
            # Chỉ fallback khi server tạm thời quá tải, không fallback lỗi auth/quota vĩnh viễn
            if any(code in error_str for code in _FALLBACK_STATUS | _RETRY_STATUS):
                print(f"⚠️  [{current_model}] {e.__class__.__name__}: {error_str[:120]}. "
                      f"Chuyển sang model tiếp theo...")
                continue
            # Lỗi nghiêm trọng (401 auth, 400 bad request) → ném ngay
            raise

        except Exception as e:
            # Lỗi mạng, timeout, v.v. → thử fallback
            last_error = e
            print(f"⚠️  [{current_model}] {e.__class__.__name__}: {str(e)[:120]}. "
                  f"Chuyển sang model tiếp theo...")
            continue

    else:
        # Vòng lặp kết thúc mà không break → tất cả model đều thất bại
        raise RuntimeError(
            f"Không thể gọi Gemini API sau khi thử toàn bộ {models_to_try}. "
            f"Lỗi cuối: {last_error}"
        ) from last_error

    # 5. Làm sạch phản hồi & xác thực nghiêm ngặt
    raw_text = _strip_markdown_json(response.text)

    try:
        ir = SchedulingIR.model_validate_json(raw_text)
    except ValidationError as ve:
        # Phân biệt rõ: lỗi cấu trúc dữ liệu (để Streamlit hiển thị thân thiện)
        raise ValidationError(ve.errors(), SchedulingIR) from ve

    # 6. Hậu xử lý: bổ sung wip_limits nếu schema constraint khiến dict trả về rỗng
    if not ir.kanban_config.wip_limits and ir.kanban_config.stages:
        inferred = _infer_wip_limits(user_text, ir.kanban_config.stages)
        if inferred:
            ir.kanban_config.wip_limits = inferred

    return ir


# ---------------------------------------------------------------------------
# Khối test nhanh – KHÔNG chạy khi file được import vào app.py
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from pathlib import Path

    # Tự động nạp .env khi chạy trực tiếp (không dùng python-dotenv để tránh phụ thuộc thêm)
    _env_path = Path(".env")
    _api_key = os.getenv("GEMINI_API_KEY", "")
    if not _api_key and _env_path.exists():
        with open(_env_path, encoding="utf-8") as _f:
            for _line in _f:
                _line = _line.strip()
                if _line.startswith("GEMINI_API_KEY="):
                    _api_key = _line.split("=", 1)[1].strip().strip('"').strip("'")
                    os.environ["GEMINI_API_KEY"] = _api_key
                    break

    if not _api_key:
        raise EnvironmentError(
            "Chưa có GEMINI_API_KEY. Đặt biến môi trường hoặc cấu hình trong file .env."
        )

    _sample = """
    Dự án "Web App Quản lý Nhân sự" có 5 thành viên.
    Quy trình Kanban gồm 4 cột theo thứ tự: Design → Backend → Frontend → Review.
    Cột Review tối đa 2 thẻ cùng lúc (WIP = 2).
    Cột Backend tối đa 3 thẻ.

    Danh sách công việc:
    - Tính năng A (Thiết kế giao diện): 3 ngày, thuộc bước Design, không phụ thuộc ai.
    - Tính năng B (API xác thực): 4 ngày, thuộc bước Backend, cần hoàn thành Tính năng A trước.
    - Tính năng C (Trang đăng nhập FE): 2 ngày, thuộc bước Frontend, cần hoàn thành Tính năng B trước.
    - Tính năng D (API quản lý nhân viên): 5 ngày, thuộc bước Backend, cần hoàn thành Tính năng A trước.
    - Tính năng E (Trang danh sách nhân viên FE): 3 ngày, thuộc bước Frontend, cần hoàn thành Tính năng D trước.
    - Tính năng F (Code review tổng thể): 2 ngày, thuộc bước Review, cần hoàn thành C và E trước.
    """

    print("=== Đang gọi Gemini để phân tích dự án... ===\n")
    _result: SchedulingIR = parse_kanban_prompt(user_text=_sample, api_key=_api_key)
    print("=== Kết quả SchedulingIR ===")
    print(_result.model_dump_json(indent=2))
