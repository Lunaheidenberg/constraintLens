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
import re
import time
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

def parse_kanban_prompt(
    user_text: str,
    api_key: str,
    model: str = "gemini-3.5-flash",
    timeout_ms: int = 30000,
) -> SchedulingIR:
    """
    Phân tích mô tả dự án bằng Gemini Flash và trả về SchedulingIR.

    Parameters
    ----------
    user_text : str
        Đoạn mô tả dự án bằng ngôn ngữ tự nhiên từ người dùng.
    api_key : str
        Google Generative AI API key.
    model : str
        Tên model Gemini sử dụng (mặc định: 'gemini-3.5-flash').
    timeout_ms : int
        Thời gian chờ tối đa cho request tính bằng mili-giây (mặc định: 30000ms = 30s).

    Returns
    -------
    SchedulingIR
        Đối tượng IR đã được Pydantic validate, sẵn sàng đưa vào validator/solver.
    """

    # 1. Khởi tạo client (SDK mới: google-genai) với timeout rõ ràng
    client = genai.Client(
        api_key=api_key,
        http_options=types.HttpOptions(timeout=timeout_ms),
    )

    # 2. System Prompt
    system_prompt = (
        "Bạn là một trợ lý trích xuất dữ liệu chuyên nghiệp.\n"
        "Hãy phân tích đoạn mô tả dự án của người dùng và thực hiện các bước sau:\n"
        "  1. Xác định tên dự án và tổng số thành viên nhóm (team_capacity >= 1).\n"
        "  2. Phân tách các cột Kanban theo đúng thứ tự luồng công việc (stages).\n"
        "  3. Trích xuất giới hạn WIP (wip_limits) thành dictionary với key là tên cột và value là số nguyên giới hạn WIP.\n"
        "     Ví dụ: nếu văn bản ghi 'Cột Review tối đa 2 thẻ, Cột Backend tối đa 3 thẻ' thì kanban_config.wip_limits phải là {\"Review\": 2, \"Backend\": 3}.\n"
        "     Tuyệt đối không để trống kanban_config.wip_limits nếu trong bài có đề cập giới hạn số thẻ/WIP.\n"
        "  4. Liệt kê toàn bộ các thẻ công việc (tasks), mỗi thẻ gồm: "
        "id (T1, T2, ...), name, duration (ngày, số nguyên dương >= 1), "
        "dependencies (danh sách id công việc tiên quyết, rỗng nếu không có), "
        "kanban_stage (tên cột Kanban tương ứng).\n"
        "Chỉ trả về JSON theo đúng schema, không giải thích thêm."
    )

    # 3. Chuyển Pydantic schema → dict an toàn cho GenAI proto
    genai_schema = _pydantic_to_genai_schema(SchedulingIR)

    # 4. Gọi API với retry và fallback cho lỗi tạm thời (503, 429, 504)
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=genai_schema,
        system_instruction=system_prompt,
    )

    models_to_try = [model]
    if "gemini-3.5-flash-lite" not in models_to_try:
        models_to_try.append("gemini-3.5-flash-lite")

    response = None
    last_error = None

    for current_model in models_to_try:
        max_retries = 3
        for attempt in range(max_retries):
            try:
                response = client.models.generate_content(
                    model=current_model,
                    contents=user_text,
                    config=config,
                )
                break
            except Exception as e:
                last_error = e
                error_msg = str(e)
                # Xử lý các lỗi tạm thời từ server Google
                if ("503" in error_msg or "429" in error_msg or "504" in error_msg) and attempt < max_retries - 1:
                    wait_seconds = 2 ** (attempt + 1)
                    print(f"⏳ [{current_model}] Server đang bận, thử lại sau {wait_seconds}s... (lần {attempt + 2}/{max_retries})")
                    time.sleep(wait_seconds)
                else:
                    break

        if response is not None:
            break

    if response is None:
        raise RuntimeError(f"Không thể gọi Gemini API sau khi thử các model {models_to_try}: {last_error}")

    # 5. Parse JSON → Pydantic (double-validate theo Rule #1 architecture.md)
    raw_json: str = response.text
    data: dict = json.loads(raw_json)
    ir = SchedulingIR.model_validate(data)

    # 6. Bổ trợ wip_limits: Google GenAI Developer API không hỗ trợ additionalProperties trong schema,
    # nên grammar-constrained decoding có thể trả về dict rỗng {}.
    # Nếu wip_limits rỗng, trích xuất bổ sung từ văn bản dựa trên danh sách stages đã nhận diện.
    if not ir.kanban_config.wip_limits and ir.kanban_config.stages:
        inferred_wips: dict[str, int] = {}
        for stage in ir.kanban_config.stages:
            p1 = rf"{re.escape(stage)}[^\n\.]*?(?:tối đa|giới hạn|WIP\s*=?)\s*(\d+)"
            p2 = rf"(?:tối đa|giới hạn|WIP\s*=?)\s*(\d+)[^\n\.]*?{re.escape(stage)}"
            m = re.search(p1, user_text, re.IGNORECASE) or re.search(p2, user_text, re.IGNORECASE)
            if m:
                inferred_wips[stage] = int(m.group(1))
        if inferred_wips:
            ir.kanban_config.wip_limits = inferred_wips

    return ir


# ---------------------------------------------------------------------------
# Khối test nhanh
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    from pathlib import Path

    API_KEY = os.getenv("GEMINI_API_KEY", "")

    # Tự động nạp từ .env nếu chưa nạp vào biến môi trường
    if not API_KEY and Path(".env").exists():
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GEMINI_API_KEY="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    API_KEY = val
                    os.environ["GEMINI_API_KEY"] = API_KEY
                    break

    if not API_KEY:
        raise EnvironmentError(
            "Chưa có GEMINI_API_KEY. "
            "Hãy đặt biến môi trường hoặc cấu hình trong file .env."
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
