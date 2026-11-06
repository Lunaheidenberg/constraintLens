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
"""

import json
import os
from typing import Any

from google import genai
from google.genai import types

from models import SchedulingIR


# ---------------------------------------------------------------------------
# Schema converter: Pydantic v2 JSON Schema → GenAI-compatible dict
# ---------------------------------------------------------------------------
# Google GenAI proto Schema chỉ hỗ trợ một tập nhỏ các key.
# Pydantic v2 sinh ra nhiều key hợp lệ theo chuẩn JSON Schema nhưng
# proto không hiểu (exclusiveMinimum, $ref, $defs, title, default, ...).
#
# Giải pháp: WHITELIST – chỉ giữ key mà proto chấp nhận, resolve $ref → inline.

_ALLOWED_KEYS = {
    "type", "format", "description", "nullable", "enum",
    "items", "properties", "required",
    "max_items", "maxItems", "min_items", "minItems",
    "any_of", "anyOf",
    "property_ordering", "propertyOrdering",
}


def _resolve(
    schema: dict[str, Any],
    defs: dict[str, Any],
    *,
    is_property_map: bool = False,
) -> dict[str, Any]:
    """
    Đệ quy giải quyết $ref và chỉ giữ lại các key mà GenAI proto hỗ trợ.

    Parameters
    ----------
    schema : dict
        JSON Schema (hoặc property map) cần xử lý.
    defs : dict
        Bảng $defs để resolve $ref.
    is_property_map : bool
        True khi đang xử lý giá trị bên trong "properties" –
        lúc này các key là TÊN property (VD: "project_name"),
        không phải schema keyword → KHÔNG áp whitelist.
    """
    if "$ref" in schema:
        ref_name = schema["$ref"].split("/")[-1]
        return _resolve(defs.get(ref_name, {}), defs)

    result: dict[str, Any] = {}
    for key, value in schema.items():
        if not is_property_map and key not in _ALLOWED_KEYS:
            continue

        if key == "properties" and isinstance(value, dict):
            result[key] = _resolve(value, defs, is_property_map=True)
            continue

        if isinstance(value, dict):
            result[key] = _resolve(value, defs)
            continue

        if isinstance(value, list):
            result[key] = [
                _resolve(v, defs) if isinstance(v, dict) else v
                for v in value
            ]
            continue

        result[key] = value

    return result


def _pydantic_to_genai_schema(model_class: type) -> dict[str, Any]:
    """Chuyển Pydantic v2 model class sang dict tương thích với GenAI proto Schema."""
    full_schema = model_class.model_json_schema()
    defs = full_schema.get("$defs", {})
    return _resolve(full_schema, defs)


# ---------------------------------------------------------------------------
# Hàm chính
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
    """

    # 1. Khởi tạo client (SDK mới: google-genai)
    client = genai.Client(api_key=api_key)

    # 2. System Prompt
    system_prompt = (
        "Bạn là một trợ lý trích xuất dữ liệu chuyên nghiệp. "
        "Hãy phân tích đoạn mô tả dự án của người dùng và thực hiện các bước sau:\n"
        "  1. Xác định tên dự án và tổng số thành viên nhóm (team_capacity).\n"
        "  2. Phân tách các cột Kanban theo đúng thứ tự luồng công việc (stages).\n"
        "  3. Trích xuất giới hạn WIP (wip_limits) cho từng cột được đề cập; "
        "nếu một cột không được nêu giới hạn, hãy suy luận giá trị hợp lý "
        "dựa trên số thành viên hoặc bỏ qua cột đó.\n"
        "  4. Liệt kê toàn bộ các thẻ công việc (tasks), mỗi thẻ gồm: "
        "id (T1, T2, ...), name, duration (ngày, số nguyên dương), "
        "dependencies (list id tiên quyết, để rỗng nếu không có), "
        "kanban_stage (tên cột Kanban mà thẻ thuộc về).\n"
        "Chỉ trả về JSON theo đúng schema được cung cấp, không giải thích thêm."
    )

    # 3. Chuyển Pydantic schema → dict an toàn cho GenAI proto
    genai_schema = _pydantic_to_genai_schema(SchedulingIR)

    # 4. Gọi API với retry cho lỗi tạm thời (503, 429, ...)
    import time

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=genai_schema,
        system_instruction=system_prompt,
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model="gemini-3.8-flash",
                contents=user_text,
                config=config,
            )
            break  # Thành công → thoát vòng lặp
        except Exception as e:
            error_msg = str(e)
            if ("503" in error_msg or "429" in error_msg) and attempt < max_retries - 1:
                wait_seconds = 2 ** (attempt + 1)  # 2s, 4s
                print(f"⏳ Server đang bận, thử lại sau {wait_seconds}s... (lần {attempt + 2}/{max_retries})")
                time.sleep(wait_seconds)
            else:
                raise  # Lỗi khác hoặc hết retry → ném lỗi ra ngoài

    # 5. Parse JSON → Pydantic (double-validate theo Rule #1 architecture.md)
    raw_json: str = response.text
    data: dict = json.loads(raw_json)
    ir = SchedulingIR.model_validate(data)

    return ir


# ---------------------------------------------------------------------------
# Khối test nhanh
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    API_KEY = os.getenv("GEMINI_API_KEY", "")

    if not API_KEY:
        raise EnvironmentError(
            "Chưa có GEMINI_API_KEY. "
            "Hãy đặt biến môi trường hoặc điền thẳng vào biến API_KEY trong file này."
        )

    sample_text = """
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

    print("=== Đang gọi Gemini Flash để phân tích dự án... ===\n")
    result: SchedulingIR = parse_kanban_prompt(user_text=sample_text, api_key=API_KEY)

    print("=== Kết quả SchedulingIR ===")
    print(result.model_dump_json(indent=2))
