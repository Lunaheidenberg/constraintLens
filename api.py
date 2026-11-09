"""
api.py
------
FastAPI Backend cho ConstraintLens - AI-Powered Kanban Flow & Bottleneck Simulator.
Cung cấp các API:
  - GET  /api/presets  : Danh sách các kịch bản mẫu (DEMO_SCENARIOS)
  - POST /api/parse    : Phân tích mô tả tự nhiên thành SchedulingIR bằng Gemini
  - POST /api/validate : Kiểm tra tính toàn vẹn và chu trình đồ thị (DAG Cycle)
  - POST /api/solve    : Giải RCPSP bằng CP-SAT và phân tích What-If Counterfactual
"""

import os
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError, model_validator

from models import KanbanConfig, SchedulingIR, Task
from parser import parse_kanban_prompt
from solver import ScheduleResult, solve_schedule
from validator import validate_ir


# =============================================================================
# KHỞI TẠO FASTAPI VÀ CẤU HÌNH CORS
# =============================================================================
app = FastAPI(
    title="ConstraintLens Backend API",
    description="API dịch vụ mô phỏng Kanban Flow, tối ưu lịch trình RCPSP và cố vấn giải cứu deadline.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# HELPER: NẠP GEMINI API KEY
# =============================================================================
def _get_gemini_api_key(provided_key: Optional[str] = None) -> str:
    """Đọc GEMINI_API_KEY từ tham số, biến môi trường hoặc file .env."""
    if provided_key and provided_key.strip():
        return provided_key.strip()

    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        env_path = Path(".env")
        if env_path.exists():
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        val = line.split("=", 1)[1].strip()
                        if (val.startswith('"') and val.endswith('"')) or (
                            val.startswith("'") and val.endswith("'")
                        ):
                            val = val[1:-1]
                        key = val
                        os.environ["GEMINI_API_KEY"] = key
                        break
    return key


# =============================================================================
# KHO KỊCH BẢN MẪU (DEMO_SCENARIOS)
# =============================================================================
DEMO_SCENARIOS: dict[str, SchedulingIR] = {
    "Kịch bản 1: Đồ án Web E-Commerce (Luồng chuẩn - 6 Tasks)": SchedulingIR(
        project_name="Đồ án Web E-Commerce",
        team_capacity=5,
        kanban_config=KanbanConfig(
            stages=["Design", "Coding", "Testing"],
            wip_limits={"Design": 2, "Coding": 3, "Testing": 2},
        ),
        tasks=[
            Task(id="T1", name="Thiết kế UI/UX", duration=3, dependencies=[], kanban_stage="Design"),
            Task(id="T2", name="Thiết kế DB Schema", duration=2, dependencies=[], kanban_stage="Design"),
            Task(id="T3", name="API Backend Auth", duration=4, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T4", name="API Backend Cart", duration=3, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T5", name="Frontend Checkout", duration=3, dependencies=["T3", "T4"], kanban_stage="Coding"),
            Task(id="T6", name="Kiểm thử tích hợp", duration=2, dependencies=["T5"], kanban_stage="Testing"),
        ],
    ),
    "Kịch bản 2: Dự án Nghẽn cổ chai ở khâu Testing (Bottleneck Demo)": SchedulingIR(
        project_name="Bottleneck Demo – WIP Squeeze",
        team_capacity=5,
        kanban_config=KanbanConfig(
            stages=["Design", "Coding", "Testing"],
            wip_limits={"Design": 1, "Coding": 2, "Testing": 1},
        ),
        tasks=[
            Task(id="T1", name="Phân tích & Thiết kế", duration=2, dependencies=[], kanban_stage="Design"),
            Task(id="T2", name="Lập trình Module A", duration=3, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T3", name="Lập trình Module B", duration=3, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T4", name="Lập trình Module C", duration=3, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T5", name="Lập trình Module D", duration=3, dependencies=["T1"], kanban_stage="Coding"),
            Task(id="T6", name="Kiểm thử Module A+B", duration=2, dependencies=["T2", "T3"], kanban_stage="Testing"),
            Task(id="T7", name="Kiểm thử Module C+D", duration=2, dependencies=["T4", "T5"], kanban_stage="Testing"),
        ],
    ),
    "Kịch bản 3: Dữ liệu lỗi phụ thuộc vòng tròn (DAG Cycle Safeguard)": SchedulingIR(
        project_name="DAG Cycle Safeguard Test",
        team_capacity=3,
        kanban_config=KanbanConfig(
            stages=["Design", "Dev", "Review"],
            wip_limits={"Design": 2, "Dev": 2, "Review": 1},
        ),
        tasks=[
            Task(id="T1", name="Phân tích yêu cầu", duration=2, dependencies=["T3"], kanban_stage="Design"),
            Task(id="T2", name="Lập trình core", duration=3, dependencies=["T1"], kanban_stage="Dev"),
            Task(id="T3", name="Code Review vòng", duration=1, dependencies=["T2"], kanban_stage="Review"),
        ],
    ),
    "Kịch bản 4: Hệ thống Microservices Phức tạp (10 Tasks - Đa luồng)": SchedulingIR(
        project_name="Hệ thống Microservices Đa luồng",
        team_capacity=4,
        kanban_config=KanbanConfig(
            stages=["Design", "Backend", "Frontend", "Testing", "Review"],
            wip_limits={"Design": 2, "Backend": 2, "Frontend": 2, "Testing": 1, "Review": 1},
        ),
        tasks=[
            Task(id="T1", name="Kiến trúc hệ thống", duration=2, dependencies=[], kanban_stage="Design"),
            Task(id="T2", name="Thiết kế DB & Event Schema", duration=2, dependencies=[], kanban_stage="Design"),
            Task(id="T3", name="Auth & User Service", duration=3, dependencies=["T1", "T2"], kanban_stage="Backend"),
            Task(id="T4", name="Payment Gateway Service", duration=4, dependencies=["T1", "T2"], kanban_stage="Backend"),
            Task(id="T5", name="Product Catalog Service", duration=3, dependencies=["T1", "T2"], kanban_stage="Backend"),
            Task(id="T6", name="Admin Portal FE", duration=3, dependencies=["T3"], kanban_stage="Frontend"),
            Task(id="T7", name="Customer Web App FE", duration=4, dependencies=["T3", "T5"], kanban_stage="Frontend"),
            Task(id="T8", name="End-to-End Testing", duration=3, dependencies=["T4", "T7"], kanban_stage="Testing"),
            Task(id="T9", name="Security & Load Audit", duration=2, dependencies=["T8"], kanban_stage="Testing"),
            Task(id="T10", name="Release & Deployment", duration=1, dependencies=["T6", "T9"], kanban_stage="Review"),
        ],
    ),
}


# =============================================================================
# CÁC PYDANTIC SCHEMAS CHO REQUEST / RESPONSE
# =============================================================================
class ParseRequest(BaseModel):
    prompt: str = Field(description="Mô tả dự án Kanban bằng ngôn ngữ tự nhiên.")
    api_key: Optional[str] = Field(default=None, description="API Key Gemini tùy chọn.")


class ValidateResponse(BaseModel):
    valid: bool = Field(description="True nếu không có lỗi, False nếu có lỗi logic hoặc DAG cycle.")
    errors: list[str] = Field(description="Danh sách thông báo lỗi bằng tiếng Việt.")


class SolveRequest(BaseModel):
    ir: SchedulingIR = Field(description="Cấu hình SchedulingIR của dự án.")
    target_deadline: Optional[int] = Field(default=None, description="Mục tiêu deadline (số ngày).")
    time_limit_sec: Optional[float] = Field(default=10.0, description="Giới hạn thời gian giải toán CP-SAT.")

    @model_validator(mode="before")
    @classmethod
    def handle_flexible_payload(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # Form 1: Đã bọc trong key 'ir'
            if "ir" in data:
                return data
            # Form 2: Gửi trực tiếp cấu trúc SchedulingIR ở root (kèm target_deadline/time_limit_sec nếu có)
            if "tasks" in data:
                data_copy = dict(data)
                target_deadline = data_copy.pop("target_deadline", None)
                time_limit_sec = data_copy.pop("time_limit_sec", 10.0)
                return {
                    "ir": data_copy,
                    "target_deadline": target_deadline,
                    "time_limit_sec": time_limit_sec,
                }
        return data


class SolveResponse(BaseModel):
    result: ScheduleResult = Field(description="Kết quả lập lịch từ solver CP-SAT.")
    rescue_suggestions: list[str] = Field(
        default_factory=list,
        description="Danh sách gợi ý What-If Counterfactual để giải cứu deadline.",
    )


# =============================================================================
# ENDPOINTS
# =============================================================================

@app.get("/api/presets", response_model=dict[str, SchedulingIR])
def get_presets():
    """Lấy toàn bộ các kịch bản mẫu có sẵn."""
    return DEMO_SCENARIOS


@app.post("/api/parse", response_model=SchedulingIR)
def parse_prompt(payload: ParseRequest):
    """
    Phân tích văn bản tự do bằng Gemini Flash để trích xuất cấu trúc SchedulingIR.
    """
    api_key = _get_gemini_api_key(payload.api_key)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Chưa có GEMINI_API_KEY. Vui lòng cấu hình trong file .env hoặc gửi kèm qua body request.",
        )

    if not payload.prompt.strip():
        raise HTTPException(status_code=400, detail="Mô tả dự án không được để trống.")

    try:
        ir = parse_kanban_prompt(user_text=payload.prompt, api_key=api_key)
        return ir
    except ValidationError as ve:
        raise HTTPException(
            status_code=422,
            detail=f"Cấu trúc dữ liệu AI trả về không khớp SchedulingIR: {ve}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi khi gọi Gemini API phân tích mô tả: {str(exc)}",
        )


@app.post("/api/validate", response_model=ValidateResponse)
def validate_schedule(ir: SchedulingIR):
    """
    Kiểm tra toàn diện tính toàn vẹn của SchedulingIR (DAG Cycle, Kanban Stages, WIP limits).
    """
    errors = validate_ir(ir, raise_on_error=False)
    return ValidateResponse(
        valid=(len(errors) == 0),
        errors=errors,
    )


@app.post("/api/solve", response_model=SolveResponse)
def solve_project_schedule(payload: SolveRequest):
    """
    Giải bài toán lập lịch dự án RCPSP bằng CP-SAT và thực hiện phân tích
    What-If Counterfactual (Cố vấn giải cứu Deadline) nếu makespan > target_deadline.
    """
    time_limit = payload.time_limit_sec if payload.time_limit_sec and payload.time_limit_sec > 0 else 10.0
    result = solve_schedule(payload.ir, time_limit_sec=time_limit)

    rescue_suggestions: list[str] = []

    # Kiểm tra nếu giải thành công và có thiết lập target_deadline
    if (
        payload.target_deadline is not None
        and payload.target_deadline > 0
        and result.status in ("OPTIMAL", "FEASIBLE")
        and result.makespan > 0
    ):
        target = payload.target_deadline

        if result.makespan <= target:
            rescue_suggestions.append(
                f"✅ Dự án hoàn thành trong {result.makespan} ngày, đã đạt mục tiêu deadline ({target} ngày)."
            )
        else:
            base_makespan = result.makespan
            stages = payload.ir.kanban_config.stages
            wip_limits = payload.ir.kanban_config.wip_limits
            capacity = payload.ir.team_capacity

            # -----------------------------------------------------------------
            # 1. Thử tăng WIP từng cột +1 (nếu WIP hiện tại < team_capacity)
            # -----------------------------------------------------------------
            for stage in stages:
                cur_wip = wip_limits.get(stage, capacity)
                if cur_wip < capacity:
                    new_wip_map = dict(wip_limits)
                    new_wip_map[stage] = cur_wip + 1

                    sim_ir = payload.ir.model_copy(
                        update={
                            "kanban_config": KanbanConfig(
                                stages=stages,
                                wip_limits=new_wip_map,
                            )
                        },
                        deep=True,
                    )
                    sim_res = solve_schedule(sim_ir, time_limit_sec=3.0)
                    if sim_res.status in ("OPTIMAL", "FEASIBLE") and sim_res.makespan < base_makespan:
                        saved = base_makespan - sim_res.makespan
                        tag = " 🎯 [ĐẠT DEADLINE!]" if sim_res.makespan <= target else ""
                        rescue_suggestions.append(
                            f"Tăng WIP cột '{stage}' từ {cur_wip} lên {cur_wip + 1}: "
                            f"Makespan giảm từ {base_makespan} xuống {sim_res.makespan} ngày "
                            f"(tiết kiệm {saved} ngày){tag}."
                        )

            # -----------------------------------------------------------------
            # 2. Thử tăng team_capacity +1
            # -----------------------------------------------------------------
            new_capacity = capacity + 1
            sim_ir_cap = payload.ir.model_copy(
                update={"team_capacity": new_capacity},
                deep=True,
            )
            sim_res_cap = solve_schedule(sim_ir_cap, time_limit_sec=3.0)
            if sim_res_cap.status in ("OPTIMAL", "FEASIBLE") and sim_res_cap.makespan < base_makespan:
                saved = base_makespan - sim_res_cap.makespan
                tag = " 🎯 [ĐẠT DEADLINE!]" if sim_res_cap.makespan <= target else ""
                rescue_suggestions.append(
                    f"Tăng nhân sự nhóm từ {capacity} lên {new_capacity} người: "
                    f"Makespan giảm từ {base_makespan} xuống {sim_res_cap.makespan} ngày "
                    f"(tiết kiệm {saved} ngày){tag}."
                )

            # -----------------------------------------------------------------
            # 3. Thử tăng đồng thời team_capacity +1 VÀ WIP của cột nghẽn +1
            #    (dành cho trường hợp WIP bị chặn bởi team_capacity)
            # -----------------------------------------------------------------
            for stage in stages:
                cur_wip = wip_limits.get(stage, capacity)
                if cur_wip == capacity:
                    new_wip_map = dict(wip_limits)
                    new_wip_map[stage] = cur_wip + 1

                    sim_ir_both = payload.ir.model_copy(
                        update={
                            "team_capacity": new_capacity,
                            "kanban_config": KanbanConfig(
                                stages=stages,
                                wip_limits=new_wip_map,
                            ),
                        },
                        deep=True,
                    )
                    sim_res_both = solve_schedule(sim_ir_both, time_limit_sec=3.0)
                    if sim_res_both.status in ("OPTIMAL", "FEASIBLE") and sim_res_both.makespan < base_makespan:
                        saved = base_makespan - sim_res_both.makespan
                        tag = " 🎯 [ĐẠT DEADLINE!]" if sim_res_both.makespan <= target else ""
                        msg = (
                            f"Tăng đồng thời nhân sự lên {new_capacity} người và WIP cột '{stage}' lên {cur_wip + 1}: "
                            f"Makespan giảm từ {base_makespan} xuống {sim_res_both.makespan} ngày "
                            f"(tiết kiệm {saved} ngày){tag}."
                        )
                        if msg not in rescue_suggestions:
                            rescue_suggestions.append(msg)

            # -----------------------------------------------------------------
            # 4. Nếu không có phương án +1 nào giảm được thời gian
            # -----------------------------------------------------------------
            if not rescue_suggestions:
                rescue_suggestions.append(
                    f"⚠️ Dự án hoàn thành sau {base_makespan} ngày, trễ hơn mục tiêu {target} ngày. "
                    f"Thử nghiệm What-If tăng +1 WIP hoặc +1 nhân sự không rút ngắn được thời gian "
                    f"(do giới hạn bởi đường găng chuỗi phụ thuộc). Cân nhắc giảm scope hoặc chia nhỏ các task phụ thuộc."
                )

    return SolveResponse(
        result=result,
        rescue_suggestions=rescue_suggestions,
    )

