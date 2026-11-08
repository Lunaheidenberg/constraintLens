"""
app.py
------
Giao diện End-to-End cho "ConstraintLens - AI-Powered Kanban Flow & Bottleneck Simulator"
Xây dựng bằng Streamlit, kết nối các module: parser → validator → solver.

Quy tắc kiến trúc (architecture.md):
- Stateless: Mọi trạng thái quan trọng lưu trong st.session_state.
- Không sửa các file backend: models.py, parser.py, validator.py, solver.py.
- Validation First: Luôn gọi validate_ir() trước khi cho phép chạy solver.
"""

import json
import os
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from pydantic import ValidationError

from models import KanbanConfig, SchedulingIR, Task
from parser import parse_kanban_prompt
from solver import ScheduleResult, ScheduledTask, solve_schedule
from validator import validate_ir

# =============================================================================
# CẤU HÌNH TRANG
# =============================================================================
st.set_page_config(
    page_title="ConstraintLens - Kanban RCPSP",
    page_icon="🔬",
    layout="wide",
    initial_sidebar_state="expanded",
)

# =============================================================================
# TẢI GEMINI API KEY TỪ .env
# =============================================================================
def _load_api_key_from_env() -> str:
    """Đọc GEMINI_API_KEY từ file .env hoặc biến môi trường hệ thống."""
    key = os.getenv("GEMINI_API_KEY", "")
    if not key:
        env_path = Path(".env")
        if env_path.exists():
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        key = line.split("=", 1)[1].strip().strip('"').strip("'")
                        os.environ["GEMINI_API_KEY"] = key
                        break
    return key

_ENV_API_KEY = _load_api_key_from_env()

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
            Task(id="T1", name="Thiết kế UI/UX", duration=3, dependencies=[],         kanban_stage="Design"),
            Task(id="T2", name="Thiết kế DB Schema", duration=2, dependencies=[],     kanban_stage="Design"),
            Task(id="T3", name="API Backend Auth", duration=4, dependencies=["T1"],   kanban_stage="Coding"),
            Task(id="T4", name="API Backend Cart", duration=3, dependencies=["T1"],   kanban_stage="Coding"),
            Task(id="T5", name="Frontend Checkout", duration=3, dependencies=["T3","T4"], kanban_stage="Coding"),
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
            Task(id="T1", name="Phân tích & Thiết kế", duration=2, dependencies=[],              kanban_stage="Design"),
            Task(id="T2", name="Lập trình Module A", duration=3, dependencies=["T1"],            kanban_stage="Coding"),
            Task(id="T3", name="Lập trình Module B", duration=3, dependencies=["T1"],            kanban_stage="Coding"),
            Task(id="T4", name="Lập trình Module C", duration=3, dependencies=["T1"],            kanban_stage="Coding"),
            Task(id="T5", name="Lập trình Module D", duration=3, dependencies=["T1"],            kanban_stage="Coding"),
            Task(id="T6", name="Kiểm thử Module A+B", duration=2, dependencies=["T2","T3"],      kanban_stage="Testing"),
            Task(id="T7", name="Kiểm thử Module C+D", duration=2, dependencies=["T4","T5"],      kanban_stage="Testing"),
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
            Task(id="T2", name="Lập trình core",     duration=3, dependencies=["T1"], kanban_stage="Dev"),
            Task(id="T3", name="Code Review vòng",   duration=1, dependencies=["T2"], kanban_stage="Review"),
        ],
    ),
}

# =============================================================================
# KHỞI TẠO SESSION STATE
# =============================================================================
def _init_session():
    if "current_ir" not in st.session_state:
        st.session_state.current_ir = None          # SchedulingIR | None
    if "last_result" not in st.session_state:
        st.session_state.last_result = None         # ScheduleResult | None
    if "api_key" not in st.session_state:
        st.session_state.api_key = _ENV_API_KEY

_init_session()

# =============================================================================
# HELPER: Chuyển đổi IR ↔ DataFrame cho st.data_editor
# =============================================================================
def ir_to_df(ir: SchedulingIR) -> pd.DataFrame:
    """Chuyển danh sách tasks trong IR thành DataFrame thân thiện với data_editor."""
    rows = []
    for t in ir.tasks:
        rows.append({
            "ID": t.id,
            "Tên công việc": t.name,
            "Cột Kanban": t.kanban_stage,
            "Thời lượng (ngày)": t.duration,
            "Phụ thuộc (ID, cách nhau bởi dấu phẩy)": ", ".join(t.dependencies),
        })
    return pd.DataFrame(rows)


def df_to_ir(df: pd.DataFrame, base_ir: SchedulingIR) -> SchedulingIR:
    """Chuyển DataFrame sau khi người dùng chỉnh sửa ngược lại thành SchedulingIR."""
    tasks = []
    for _, row in df.iterrows():
        raw_deps = str(row.get("Phụ thuộc (ID, cách nhau bởi dấu phẩy)", "") or "")
        deps = [d.strip() for d in raw_deps.split(",") if d.strip()]
        tasks.append(Task(
            id=str(row["ID"]).strip(),
            name=str(row["Tên công việc"]).strip(),
            kanban_stage=str(row["Cột Kanban"]).strip(),
            duration=int(row["Thời lượng (ngày)"]),
            dependencies=deps,
        ))
    return SchedulingIR(
        project_name=base_ir.project_name,
        team_capacity=base_ir.team_capacity,
        kanban_config=base_ir.kanban_config,
        tasks=tasks,
    )


# =============================================================================
# HELPER: Vẽ Gantt Chart bằng Plotly (Đồng bộ Dark Mode & Dashboard Chuyên nghiệp)
# =============================================================================
_KNOWN_STAGE_COLORS = {
    "design": "#f59e0b",    # Amber
    "coding": "#3b82f6",    # Royal Blue
    "dev": "#3b82f6",
    "backend": "#3b82f6",
    "frontend": "#3b82f6",
    "testing": "#10b981",   # Emerald Green
    "test": "#10b981",
    "review": "#8b5cf6",   # Purple
}
_FALLBACK_STAGE_COLORS = [
    "#8b5cf6",  # Purple
    "#ec4899",  # Pink
    "#06b6d4",  # Cyan
    "#a855f7",  # Violet
    "#14b8a6",  # Teal
    "#f97316",  # Orange
]


def _get_stage_color(stage_name: str, index: int = 0) -> str:
    """Xác định mã màu sắc nét chuẩn UI cho từng cột Kanban."""
    key = stage_name.strip().lower()
    if key in _KNOWN_STAGE_COLORS:
        return _KNOWN_STAGE_COLORS[key]
    return _FALLBACK_STAGE_COLORS[index % len(_FALLBACK_STAGE_COLORS)]


def _build_gantt(result: ScheduleResult) -> go.Figure:
    """Xây dựng Gantt Chart Dark Mode chuyên nghiệp với thanh chờ WIP và đường Makespan."""
    tasks_sorted = sorted(result.scheduled_tasks, key=lambda t: t.start_day)

    # Lập bảng màu theo từng stage
    stages = list({t.kanban_stage for t in tasks_sorted})
    color_map = {s: _get_stage_color(s, idx) for idx, s in enumerate(stages)}

    fig = go.Figure()

    for task in tasks_sorted:
        bar_color = color_map.get(task.kanban_stage, "#8b5cf6")
        label = f"<b>{task.id}: {task.name}</b>"
        deps_str = ", ".join(task.dependencies) if task.dependencies else "Không có"

        # --- 1. Thanh thực thi chính ---
        main_hover = (
            f"<b>{task.id}: {task.name}</b><br>"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━<br>"
            f"🏷️ Cột Kanban: <b>{task.kanban_stage}</b><br>"
            f"⏱️ Thời lượng: <b>{task.duration} ngày</b><br>"
            f"📅 Thực thi: <b>Ngày {task.start_day} → Ngày {task.end_day}</b><br>"
            f"⚡ Sẵn sàng: <b>Ngày {task.earliest_ready_day}</b><br>"
            f"⏳ Chờ WIP: <b>{task.queue_wait_days} ngày</b><br>"
            f"🔗 Phụ thuộc: <b>{deps_str}</b>"
            "<extra></extra>"
        )

        fig.add_trace(go.Bar(
            name=task.kanban_stage,
            orientation="h",
            y=[label],
            x=[task.duration],
            base=[task.start_day],
            text=[f"<b>{task.duration}d (N{task.start_day}→N{task.end_day})</b>"],
            textposition="inside",
            insidetextanchor="middle",
            textfont=dict(color="#ffffff", size=12, family="sans-serif"),
            marker=dict(
                color=bar_color,
                line=dict(color="#ffffff", width=1.5),
            ),
            hovertemplate=main_hover,
            showlegend=False,
        ))

        # --- 2. Thanh chờ WIP nếu task bị kẹt ở hàng đợi (queue_wait_days > 0) ---
        if task.queue_wait_days > 0:
            wait_hover = (
                f"<b>⏳ HÀNG ĐỢI KANBAN: {task.id} ({task.name})</b><br>"
                f"━━━━━━━━━━━━━━━━━━━━━━━━━<br>"
                f"🏷️ Cột chờ: <b>{task.kanban_stage}</b><br>"
                f"⚡ Sẵn sàng từ: <b>Ngày {task.earliest_ready_day}</b><br>"
                f"🚀 Bắt đầu thực tế: <b>Ngày {task.start_day}</b><br>"
                f"🛑 Thời gian kẹt WIP: <b>{task.queue_wait_days} ngày</b>"
                "<extra></extra>"
            )

            fig.add_trace(go.Bar(
                name=f"Chờ WIP ({task.id})",
                orientation="h",
                y=[label],
                x=[task.queue_wait_days],
                base=[task.earliest_ready_day],
                text=[f"<b>⏳ Chờ {task.queue_wait_days}d</b>"],
                textposition="inside",
                insidetextanchor="middle",
                textfont=dict(color="#fda4af", size=11, family="sans-serif"),
                marker=dict(
                    color="#334155",
                    pattern=dict(shape="/", fgcolor="#f43f5e", bgcolor="#334155"),
                    line=dict(color="#f43f5e", width=1.5),
                ),
                hovertemplate=wait_hover,
                showlegend=False,
            ))

    # --- 3. Legend danh mục từng cột Kanban ---
    for stage in stages:
        color = color_map.get(stage, "#8b5cf6")
        fig.add_trace(go.Bar(
            name=stage,
            x=[None], y=[None],
            marker=dict(color=color, line=dict(color="#ffffff", width=1)),
            showlegend=True,
        ))

    # --- 4. Đường đích Makespan Line nét đứt màu đỏ ---
    if result.makespan > 0:
        fig.add_vline(
            x=result.makespan,
            line_width=2,
            line_dash="dash",
            line_color="#ef4444",
            annotation_text=f"🏁 Makespan: {result.makespan} ngày",
            annotation_position="top right",
            annotation_font=dict(color="#ef4444", size=12, family="sans-serif"),
        )

    # --- 5. Bố cục Dark Mode tương phản cao ---
    fig.update_layout(
        barmode="overlay",
        height=max(320, 55 * len(tasks_sorted) + 140),
        plot_bgcolor="#1e293b",
        paper_bgcolor="#0f172a",
        xaxis=dict(
            title=dict(text="<b>Ngày (Timeline)</b>", font=dict(color="#f8fafc", size=13)),
            tickmode="linear",
            tick0=0,
            dtick=1,
            tickfont=dict(color="#f8fafc", size=13),
            title_font=dict(color="#f8fafc", size=13),
            gridcolor="#334155",
            gridwidth=1,
            griddash="dot",
            zeroline=True,
            zerolinecolor="#475569",
            automargin=True,
        ),
        yaxis=dict(
            autorange="reversed",
            tickfont=dict(color="#f8fafc", size=13),
            gridcolor="#1e293b",
            automargin=True,
            ticklabelstandoff=10,
        ),
        legend=dict(
            title=dict(text="<b>Cột Kanban</b>", font=dict(color="#f8fafc", size=13)),
            font=dict(color="#f8fafc", size=13),
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="right",
            x=1,
        ),
        margin=dict(l=220, r=40, t=50, b=60),
    )
    fig.update_xaxes(automargin=True)
    fig.update_yaxes(automargin=True, ticklabelstandoff=10)
    return fig


# =============================================================================
# HELPER: Pipeline status indicator
# =============================================================================
def _render_pipeline_status(has_ir: bool, has_errors: bool, has_result: bool):
    steps = [
        ("1. Understand (IR)", has_ir),
        ("2. Validate (DAG)", has_ir and not has_errors),
        ("3. Solve (CP-SAT)", has_result),
        ("4. Visualize", has_result),
    ]
    cols = st.columns(len(steps))
    for col, (label, done) in zip(cols, steps):
        if done:
            col.success(f"✅ {label}")
        elif has_ir and label.startswith("2") and has_errors:
            col.error(f"❌ {label}")
        else:
            col.info(f"⬜ {label}")


# =============================================================================
# HEADER
# =============================================================================
st.markdown(
    """
    <div style="
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
        padding: 2rem 2.5rem;
        border-radius: 12px;
        margin-bottom: 1.5rem;
    ">
        <h1 style="color:#e94560; margin:0; font-size:2rem;">
            🔬 ConstraintLens
        </h1>
        <p style="color:#a8b2d8; margin:0.4rem 0 0 0; font-size:1.1rem;">
            AI-Powered Kanban Flow &amp; Bottleneck Simulator &nbsp;|&nbsp;
            <span style="color:#64ffda;">CP-SAT · RCPSP · Kanban WIP</span>
        </p>
    </div>
    """,
    unsafe_allow_html=True,
)

# =============================================================================
# SIDEBAR – KHỐI 1: Nguồn dữ liệu & Cấu hình Kanban
# =============================================================================
with st.sidebar:
    st.markdown("## ⚙️ Cấu hình & Nguồn dữ liệu")

    # --- API Key ---
    with st.expander("🔑 Gemini API Key", expanded=not bool(st.session_state.api_key)):
        entered_key = st.text_input(
            "API Key",
            value=st.session_state.api_key,
            type="password",
            placeholder="AIza...",
            help="Lấy key tại https://aistudio.google.com",
        )
        if entered_key:
            st.session_state.api_key = entered_key
        if st.session_state.api_key:
            st.success("✅ API Key đã sẵn sàng")
        else:
            st.warning("⚠️ Chưa có API Key – chức năng AI sẽ bị tắt")

    st.divider()

    # --- Chọn chế độ nhập ---
    st.markdown("### 📥 Nguồn dữ liệu")
    input_mode = st.radio(
        "Chọn cách nạp dữ liệu:",
        options=[
            "A – Kịch bản mẫu có sẵn",
            "B – Mô tả ngôn ngữ tự nhiên / File .txt, .md",
            "C – Upload file JSON (SchedulingIR)",
        ],
        label_visibility="collapsed",
    )

    # ---- CHẾ ĐỘ A: Kịch bản mẫu ----
    if input_mode.startswith("A"):
        selected_scenario = st.selectbox(
            "Chọn kịch bản:",
            options=list(DEMO_SCENARIOS.keys()),
        )
        if st.button("▶️ Nạp kịch bản này", type="primary", use_container_width=True):
            st.session_state.current_ir = DEMO_SCENARIOS[selected_scenario].model_copy(deep=True)
            st.session_state.last_result = None
            st.success(f"✅ Đã nạp: **{selected_scenario[:40]}...**")
            st.rerun()

    # ---- CHẾ ĐỘ B: Ngôn ngữ tự nhiên / file text ----
    elif input_mode.startswith("B"):
        uploaded_txt = st.file_uploader(
            "Tải lên file .txt hoặc .md (tùy chọn)",
            type=["txt", "md"],
            key="txt_upload",
        )
        default_text = ""
        if uploaded_txt:
            default_text = uploaded_txt.read().decode("utf-8", errors="replace")

        user_prompt = st.text_area(
            "Mô tả dự án bằng ngôn ngữ tự nhiên:",
            value=default_text,
            height=200,
            placeholder=(
                "Ví dụ: Dự án có 4 thành viên. Quy trình: Design → Dev → Testing.\n"
                "Cột Dev tối đa 2 task cùng lúc.\n"
                "Task 1: Thiết kế UI (3 ngày, Design)...\n"
            ),
        )

        if st.button("🤖 Phân tích bằng AI", type="primary", use_container_width=True):
            if not st.session_state.api_key:
                st.error("❌ Chưa có Gemini API Key. Hãy nhập ở trên.")
            elif not user_prompt.strip():
                st.error("❌ Vui lòng nhập mô tả dự án.")
            else:
                with st.spinner("🧠 Đang gọi Gemini để phân tích... (tối đa 20 giây)"):
                    try:
                        ir = parse_kanban_prompt(user_prompt, st.session_state.api_key)
                        st.session_state.current_ir = ir
                        st.session_state.last_result = None
                        st.success(f"✅ Phân tích xong: **{ir.project_name}** – {len(ir.tasks)} tasks")
                        st.rerun()
                    except ValidationError as ve:
                        st.error(f"❌ Dữ liệu AI trả về không đúng cấu trúc:\n\n`{ve}`")
                    except Exception as exc:
                        st.error(f"❌ Lỗi khi gọi API:\n\n`{exc}`")

    # ---- CHẾ ĐỘ C: Upload JSON ----
    else:
        uploaded_json = st.file_uploader(
            "Tải lên file JSON (SchedulingIR)",
            type=["json"],
            key="json_upload",
        )
        if uploaded_json:
            try:
                raw = uploaded_json.read().decode("utf-8")
                ir = SchedulingIR.model_validate_json(raw)
                st.session_state.current_ir = ir
                st.session_state.last_result = None
                st.success(f"✅ Đã tải: **{ir.project_name}** – {len(ir.tasks)} tasks")
                st.rerun()
            except Exception as exc:
                st.error(f"❌ File JSON không hợp lệ:\n\n`{exc}`")

    # --- WHAT-IF sliders (chỉ hiện khi đã có IR) ---
    if st.session_state.current_ir is not None:
        ir_ref: SchedulingIR = st.session_state.current_ir
        st.divider()
        st.markdown("### 🎛️ Thử nghiệm What-If")
        st.caption("Kéo thanh trượt rồi bấm **Giải lại** ở trang chính.")

        new_capacity = st.slider(
            "👥 Nhân sự nhóm (team_capacity)",
            min_value=1,
            max_value=max(10, ir_ref.team_capacity * 2),
            value=ir_ref.team_capacity,
            step=1,
        )

        kanban_ref = ir_ref.kanban_config
        new_wip = {}
        for stage in kanban_ref.stages:
            current_wip = kanban_ref.wip_limits.get(stage, new_capacity)
            new_wip[stage] = st.slider(
                f"WIP – {stage}",
                min_value=1,
                max_value=new_capacity,
                value=min(current_wip, new_capacity),
                step=1,
                key=f"wip_{stage}",
            )

        if st.button("🔄 Áp dụng What-If", use_container_width=True):
            updated_ir = ir_ref.model_copy(
                update={
                    "team_capacity": new_capacity,
                    "kanban_config": KanbanConfig(
                        stages=kanban_ref.stages,
                        wip_limits=new_wip,
                    ),
                },
                deep=True,
            )
            st.session_state.current_ir = updated_ir
            st.session_state.last_result = None
            st.success("✅ Đã cập nhật cấu hình. Bấm 🚀 để giải lại.")
            st.rerun()

        st.divider()

        # --- Xuất IR ra JSON ---
        ir_json = st.session_state.current_ir.model_dump_json(indent=2)
        st.download_button(
            label="💾 Xuất IR ra file JSON",
            data=ir_json,
            file_name=f"{ir_ref.project_name.replace(' ', '_')}_IR.json",
            mime="application/json",
            use_container_width=True,
        )

# =============================================================================
# MAIN AREA – KHỐI 2, 3, 4
# =============================================================================
current_ir: SchedulingIR | None = st.session_state.current_ir
last_result: ScheduleResult | None = st.session_state.last_result

if current_ir is None:
    # Màn hình chào khi chưa có dữ liệu
    st.info(
        "👈 **Bắt đầu bằng cách chọn nguồn dữ liệu ở Sidebar bên trái.**\n\n"
        "- **Chế độ A**: Nạp ngay một trong 3 kịch bản mẫu để xem demo.\n"
        "- **Chế độ B**: Mô tả dự án bằng tiếng Việt tự nhiên, AI sẽ phân tích.\n"
        "- **Chế độ C**: Upload file JSON nếu bạn đã có cấu hình SchedulingIR.\n\n"
        "Sau khi nạp dữ liệu, bạn có thể chỉnh sửa bảng task, kéo thanh trượt WIP "
        "*(What-If Analysis)* và bấm **🚀 Giải toán** để xem Gantt Chart và phân tích điểm nghẽn."
    )
    st.stop()

# Có IR → hiển thị pipeline status
kanban_cfg = current_ir.kanban_config
validation_errors = validate_ir(current_ir, raise_on_error=False)
has_errors = len(validation_errors) > 0

tab_editor, tab_result = st.tabs(["📋 Bảng Duyệt & Chỉnh sửa", "📊 Kết quả & Biểu đồ"])

# =============================================================================
# TAB 1: KHỐI 2 – Bảng chỉnh sửa và KHỐI 3 – Validation + Solve button
# =============================================================================
with tab_editor:
    _render_pipeline_status(
        has_ir=True,
        has_errors=has_errors,
        has_result=last_result is not None,
    )

    st.markdown(f"### 📁 Dự án: **{current_ir.project_name}**")
    st.caption(
        f"Nhân sự: {current_ir.team_capacity} người &nbsp;|&nbsp; "
        f"Số cột: {len(kanban_cfg.stages)} &nbsp;|&nbsp; "
        f"Số task: {len(current_ir.tasks)}"
    )

    # --- KHỐI 2: st.data_editor ---
    st.markdown("#### ✏️ Chỉnh sửa danh sách công việc")
    st.caption(
        "Bạn có thể thêm/xóa/sửa task trực tiếp trong bảng. "
        "Trường **Phụ thuộc** dùng ID cách nhau bằng dấu phẩy, ví dụ: `T1, T2`."
    )

    edited_df = st.data_editor(
        ir_to_df(current_ir),
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "ID": st.column_config.TextColumn("ID", width="small", required=True),
            "Tên công việc": st.column_config.TextColumn("Tên công việc", width="large", required=True),
            "Cột Kanban": st.column_config.SelectboxColumn(
                "Cột Kanban",
                options=kanban_cfg.stages,
                width="medium",
                required=True,
            ),
            "Thời lượng (ngày)": st.column_config.NumberColumn(
                "Thời lượng (ngày)",
                min_value=1,
                step=1,
                width="small",
                required=True,
            ),
            "Phụ thuộc (ID, cách nhau bởi dấu phẩy)": st.column_config.TextColumn(
                "Phụ thuộc (ID cách bởi dấu phẩy)",
                width="large",
                help="Nhập ID các task phải hoàn thành trước, cách nhau bằng dấu phẩy. Để trống nếu không có.",
            ),
        },
        key="task_editor",
    )

    # Đồng bộ DataFrame đã chỉnh sửa ngược lại IR
    try:
        if not edited_df.empty:
            updated_ir_from_editor = df_to_ir(edited_df, current_ir)
            # Chỉ cập nhật session nếu thực sự có thay đổi
            if updated_ir_from_editor.model_dump_json() != current_ir.model_dump_json():
                st.session_state.current_ir = updated_ir_from_editor
                st.session_state.last_result = None
                current_ir = updated_ir_from_editor
                validation_errors = validate_ir(current_ir, raise_on_error=False)
                has_errors = len(validation_errors) > 0
    except Exception as parse_err:
        st.warning(f"⚠️ Không thể đọc bảng chỉnh sửa: `{parse_err}`")

    st.divider()

    # --- KHỐI 3: Validation + Solve Button ---
    st.markdown("#### 🔍 Kiểm tra dữ liệu (tự động)")

    if validation_errors:
        st.error(
            f"**❌ Phát hiện {len(validation_errors)} lỗi – Vui lòng sửa trước khi giải toán:**\n\n"
            + "\n".join(f"- {e}" for e in validation_errors)
        )
    else:
        st.success(f"✅ Dữ liệu hợp lệ – {len(current_ir.tasks)} tasks, không có lỗi DAG.")

    col_btn, col_time = st.columns([3, 1])
    with col_btn:
        solve_clicked = st.button(
            "🚀 Chạy Tối Ưu Hóa Lịch Trình (CP-SAT)",
            type="primary",
            disabled=has_errors,
            use_container_width=True,
            help="Bấm để giải bài toán lập lịch tối ưu có ràng buộc WIP." if not has_errors
                 else "Hãy sửa hết lỗi trước khi chạy.",
        )
    with col_time:
        time_limit = st.number_input(
            "Giới hạn (giây)",
            min_value=1.0,
            max_value=60.0,
            value=10.0,
            step=1.0,
            help="Giới hạn thời gian cho CP-SAT solver",
        )

    if solve_clicked and not has_errors:
        with st.spinner("⚙️ CP-SAT đang tìm lịch trình tối ưu..."):
            try:
                result = solve_schedule(current_ir, time_limit_sec=float(time_limit))
                st.session_state.last_result = result
                last_result = result
                if result.status in ("OPTIMAL", "FEASIBLE"):
                    st.success(
                        f"✅ Giải thành công! Trạng thái: **{result.status}** | "
                        f"Makespan: **{result.makespan} ngày** | "
                        f"Thời gian giải: **{result.solve_time_ms:.1f} ms**"
                    )
                    st.balloons()
                else:
                    st.error(f"❌ Solver trả về: **{result.status}**\n\n" + "\n".join(result.errors))
            except Exception as exc:
                st.error(f"❌ Lỗi nội bộ khi chạy solver:\n\n`{exc}`")
        st.rerun()


# =============================================================================
# TAB 2: KHỐI 4 – KPI, Gantt Chart, Phân tích Bottleneck
# =============================================================================
with tab_result:
    _render_pipeline_status(
        has_ir=True,
        has_errors=has_errors,
        has_result=last_result is not None,
    )

    if last_result is None:
        st.info(
            "📌 Chưa có kết quả. Hãy sang tab **📋 Bảng Duyệt & Chỉnh sửa**, "
            "kiểm tra dữ liệu và bấm **🚀 Chạy Tối Ưu Hóa Lịch Trình**."
        )
        st.stop()

    result = last_result

    # --- KPI Metrics ---
    st.markdown("### 📈 Chỉ số tổng quan dự án")
    total_wait = sum(t.queue_wait_days for t in result.scheduled_tasks)

    kpi1, kpi2, kpi3, kpi4 = st.columns(4)
    status_icon = {"OPTIMAL": "🟢", "FEASIBLE": "🟡", "INFEASIBLE": "🔴"}.get(result.status, "⚫")
    kpi1.metric(
        label="Trạng thái Solver",
        value=f"{status_icon} {result.status}",
    )
    kpi2.metric(
        label="⏱️ Tổng thời gian dự án",
        value=f"{result.makespan} ngày",
    )
    kpi3.metric(
        label="⏳ Tổng ngày chờ WIP",
        value=f"{total_wait} ngày",
        delta=f"-{total_wait} hiệu suất" if total_wait > 0 else "Không nghẽn",
        delta_color="inverse" if total_wait > 0 else "off",
    )
    kpi4.metric(
        label="⚡ Thời gian giải toán",
        value=f"{result.solve_time_ms:.1f} ms",
    )

    st.divider()

    # --- Gantt Chart ---
    st.markdown("### 📅 Biểu đồ Timeline (Gantt Chart)")
    if total_wait > 0:
        st.info(
            "💡 **Chú thích:** Thanh **mờ/kẻ sọc** (⏳) biểu thị khoảng thời gian task bị kẹt "
            "trong hàng chờ Kanban trước khi được thực thi."
        )

    fig = _build_gantt(result)
    st.plotly_chart(fig, use_container_width=True, theme=None)

    # --- Bảng chi tiết task ---
    with st.expander("📋 Bảng chi tiết từng task", expanded=False):
        task_rows = []
        for t in sorted(result.scheduled_tasks, key=lambda x: x.start_day):
            task_rows.append({
                "ID": t.id,
                "Tên": t.name,
                "Cột Kanban": t.kanban_stage,
                "Bắt đầu (Ngày)": t.start_day,
                "Kết thúc (Ngày)": t.end_day,
                "Thời lượng": t.duration,
                "Sẵn sàng (Ngày)": t.earliest_ready_day,
                "Chờ WIP (Ngày)": t.queue_wait_days,
                "Phụ thuộc": ", ".join(t.dependencies) if t.dependencies else "—",
            })
        task_df = pd.DataFrame(task_rows)

        def _highlight_wait(val):
            if isinstance(val, (int, float)) and val > 0:
                return "background-color: #fff3cd; color: #856404; font-weight: bold;"
            return ""

        styler = task_df.style
        if hasattr(styler, "map"):
            styled_df = styler.map(_highlight_wait, subset=["Chờ WIP (Ngày)"])
        else:
            styled_df = styler.applymap(_highlight_wait, subset=["Chờ WIP (Ngày)"])

        st.dataframe(
            styled_df,
            use_container_width=True,
            hide_index=True,
        )

    st.divider()

    # --- Phân tích Bottleneck từng cột Kanban ---
    st.markdown("### 🔴 Phân tích Điểm Nghẽn theo Cột Kanban")

    bottleneck_found = False
    for metric in result.stage_metrics:
        if metric.is_bottleneck:
            bottleneck_found = True
            break

    if not bottleneck_found and total_wait == 0:
        st.success(
            "✅ **Không phát hiện điểm nghẽn!** "
            "Toàn bộ luồng Kanban hoạt động trơn tru với cấu hình hiện tại."
        )
    else:
        st.warning(
            f"⚠️ **Phát hiện {len(result.bottleneck_stages)} điểm nghẽn:** "
            f"{', '.join(f'**{s}**' for s in result.bottleneck_stages)}"
        )

    # Bảng metrics từng cột
    metric_rows = []
    for m in result.stage_metrics:
        metric_rows.append({
            "Cột Kanban": m.stage_name,
            "WIP Limit": m.wip_limit,
            "Tổng Task-Days": m.total_task_days,
            "Peak Đồng thời": m.peak_concurrent_tasks,
            "Tổng Ngày Chờ": m.total_queue_wait_days,
            "Nghẽn?": "🔴 CÓ" if m.is_bottleneck else "🟢 KHÔNG",
        })

    metric_df = pd.DataFrame(metric_rows)

    def _highlight_bottleneck_row(row):
        if row["Nghẽn?"].startswith("🔴"):
            return ["background-color: #fff3cd; font-weight: bold;"] * len(row)
        return [""] * len(row)

    st.dataframe(
        metric_df.style.apply(_highlight_bottleneck_row, axis=1),
        use_container_width=True,
        hide_index=True,
    )

    # --- Lời khuyên tự động cho từng bottleneck ---
    advice_given = False
    for m in result.stage_metrics:
        if m.is_bottleneck:
            if not advice_given:
                st.markdown("#### 💡 Khuyến nghị cải thiện")
                advice_given = True
            st.warning(
                f"🔴 **Cột '{m.stage_name}'** đang gây trễ **{m.total_queue_wait_days} ngày** "
                f"(WIP Limit = {m.wip_limit}, Peak đồng thời = {m.peak_concurrent_tasks}).\n\n"
                f"→ Hãy thử **tăng WIP Limit của cột '{m.stage_name}'** ở thanh trượt bên trái "
                f"rồi bấm **🔄 Áp dụng What-If** để xem thời gian dự án giảm xuống như thế nào!"
            )

    # --- Xuất kết quả ---
    st.divider()
    with st.expander("💾 Xuất kết quả"):
        col_dl1, col_dl2 = st.columns(2)
        with col_dl1:
            st.download_button(
                label="📥 Tải kết quả JSON (ScheduleResult)",
                data=result.model_dump_json(indent=2),
                file_name=f"{current_ir.project_name.replace(' ', '_')}_result.json",
                mime="application/json",
                use_container_width=True,
            )
        with col_dl2:
            task_csv = pd.DataFrame([
                {
                    "id": t.id, "name": t.name, "stage": t.kanban_stage,
                    "start_day": t.start_day, "end_day": t.end_day,
                    "duration": t.duration, "queue_wait_days": t.queue_wait_days,
                    "dependencies": "|".join(t.dependencies),
                }
                for t in result.scheduled_tasks
            ]).to_csv(index=False)
            st.download_button(
                label="📥 Tải lịch trình CSV (Gantt data)",
                data=task_csv,
                file_name=f"{current_ir.project_name.replace(' ', '_')}_gantt.csv",
                mime="text/csv",
                use_container_width=True,
            )

