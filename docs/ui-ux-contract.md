# Hợp đồng đồng bộ UI – UX (ConstraintLens)

Tài liệu này là **điểm chuẩn dùng chung** giữa người làm **UX (luồng, trạng thái, câu chữ, quy tắc nghiệp vụ)** và người làm **UI (bố cục, CSS/Tailwind, màu sắc, typography, responsive)** để chỉnh giao diện tự do mà không làm gãy trải nghiệm hoặc kiểm thử.

---

## 1. Ranh giới sở hữu

| Hạng mục | UX chủ trì | UI chủ trì | Tệp chính |
|---|---|---|---|
| Luồng thao tác, thứ tự bước, tự cuộn, chuyển tab | **Chủ trì** | Phản biện khả thi | `frontend/src/App.tsx` |
| Ma trận trạng thái (Empty, Loading, Warning, Error, Locked) | **Chủ trì** | Hiển thị đủ trạng thái | `App.tsx`, `ProgressEditor.tsx`, `PlanningAssistant.tsx` |
| Nhãn nút, thuật ngữ tiếng Việt, thông báo lỗi | **Chủ trì** | Dùng đúng nguyên văn | `App.tsx`, `application_guide.py`, `Schedule.tsx` |
| Token màu sắc, spacing, bảng, card, responsive 1280px/mobile | Góp ý độ rõ | **Chủ trì** | `frontend/src/index.css`, Tailwind classes |
| Accessibility (`aria-*`, focus, phím `Esc`, tab order) | Kiểm thử tay | **Chủ trì** | Toàn bộ `frontend/src/*.tsx` |

---

## 2. Bảng thuật ngữ & nhãn UI cố định (Copy Glossary)

> **Quy tắc:** Khi đổi bất kỳ nhãn nào trong bảng dưới đây, **phải cập nhật đồng thời** trong `application_guide.py` và `tests/test_application_guide.py` ở cùng commit/PR.

| Vị trí | Nhãn chuẩn đang dùng | Vai trò |
|---|---|---|
| Thanh điều hướng | `Thiết lập` · `Kế hoạch` · `Tiến độ` | 3 bước quy trình chính |
| Header (nhóm Tệp) | `Dự án mới` · `Xuất JSON` · `Nhập JSON` | Quản lý workspace JSON / localStorage |
| Header (AI & Trợ giúp) | `Gemini: BYOK (trực tiếp)` / `Gemini: Sẵn sàng` / `Cài đặt Gemini AI & BYOK` · `Hướng dẫn sử dụng` | Cấu hình AI & hỏi cách dùng app |
| Tab Thiết lập | `Kịch bản & mẫu chạy thử` · `Ngày bắt đầu dự án` · `Hạn chót (tùy chọn)` · `AI giúp lập kế hoạch` | Khởi tạo dữ liệu & bản nháp AI |
| Bản nháp AI | `Áp dụng bản nháp` · `Xác nhận các gợi ý` · `Bỏ qua tất cả` | Duyệt gợi ý thời lượng, tiên quyết, phân công |
| Tab Kế hoạch | `Thêm công việc` · `Chỉnh sửa` · `Người phụ trách` · `Tính lịch ban đầu` · `Chấp nhận lịch` | Chỉnh dữ liệu & giải lịch CP-SAT |
| Biểu đồ Gantt | `Theo công việc` · `Theo thành viên` · `Hạn mục tiêu` · `Vượt hạn chót` | Đối chiếu lịch & swimlane |
| Cảnh báo & Đề xuất | `Điều chỉnh kế hoạch` · `So sánh kế hoạch` · `Chi tiết thay đổi` · `Trợ lý phân tích lịch` | Đọc tác động & giải thích lịch dự án |
| Tab Tiến độ | `Bảng Kanban` · `Di chuyển` · `Báo cáo tiến độ` · `Theo kế hoạch` · `Dùng ngày báo cáo` · `Kiểm tra tiến độ` · `Đề xuất lịch mới` | Cập nhật tiến độ thực tế & lập lại lịch |

---

## 3. Ma trận 5 trạng thái bắt buộc

Mỗi màn hình/khối khi thiết kế lại CSS/layout **phải giữ nguyên hiển thị cho đủ 5 trạng thái**:

1. **Thiết lập (`#workspace-setup`):**
   - *Empty:* Bảng trống, hướng dẫn thêm task hoặc chọn `Kịch bản & mẫu chạy thử`.
   - *Loading:* AI Clarify / Draft đang chạy (`aria-busy`, nút vô hiệu).
   - *Success:* Notice xanh sau khi nạp mẫu/thêm task có nút `Đến Kế hoạch`.
   - *Warning:* Dự án đang có dữ liệu (`applyBlocked`) → cảnh báo sớm ngay dưới ô mô tả AI.
   - *Error / Locked:* Lỗi JSON import, lỗi kết nối API hoặc lỗi khóa BYOK (không lộ key).
2. **Kế hoạch (`Schedule` + `ProjectEditor`):**
   - *Empty:* Chưa có task hoặc chưa tính lịch.
   - *Loading:* CP-SAT đang giải (`Tính lịch ban đầu` / `Lập lịch lại`).
   - *Success:* Đề xuất tối ưu/khả thi đúng hạn (`Chấp nhận lịch` mở).
   - *Warning:* Thời lượng vượt khoảng hạn chót (cảnh báo sớm, **không chặn giải**), hoặc đề xuất trễ hạn (tô đỏ đoạn vượt hạn, hiển thị `DeadlineWarning`, **khóa nút `Chấp nhận lịch`**).
   - *Locked:* Các task đã xác nhận hoàn thành (`Done` trong báo cáo đã gửi) bị khóa sửa `duration` / `status` / xóa.
3. **Tiến độ (`Kanban` + `ProgressEditor` + `RecoveryAssistant`):**
   - *Empty:* Chưa có lịch được chấp nhận → hiện nút quay lại Kế hoạch.
   - *Loading:* Đang `Kiểm tra tiến độ` / `Đề xuất lịch mới` / AI giải thích lịch.
   - *Success:* Đề xuất lịch mới + `So sánh kế hoạch` + thanh action sticky `Chấp nhận lịch / Hủy đề xuất`.
   - *Warning:* Kéo/chuyển thẻ sang `Doing`/`Done` khi tiên quyết chưa `Done` → hiện cảnh báo ngay trên thẻ và chặn nút `Dùng ngày báo cáo` trước ngày xong của tiên quyết; `todoReview` bắt xác nhận checkbox.
   - *Locked:* Task đã xác nhận hoàn thành cố định ở cột `Done`.

---

## 4. Ràng buộc nghiệp vụ & UX cấm phá

1. **Không tự gán `actual_finish_date`** khi người dùng kéo/đổi trạng thái task sang `Done`. Chỉ điền khi bấm nút `Dùng ngày báo cáo` hoặc nhập tay.
2. **Không chặn giải lịch khi dự án trễ hạn:** Trễ hạn vẫn chạy CP-SAT và vẽ Gantt để thấy rõ số ngày trễ + phần tô đỏ; chỉ chặn nút `Chấp nhận lịch`.
3. **Zero-Server-Knowledge cho BYOK:** Tuyệt đối không ghi API key vào `localStorage`, `sessionStorage`, file Export JSON, URL query, console log hay response API.
4. **Phân biệt rõ 2 trợ lý:** `Hướng dẫn sử dụng` (modal hỏi đáp chung từ header) ≠ `Trợ lý phân tích lịch` (side drawer bên phải kèm `TL;DR` cho đề xuất & lịch đã chấp nhận).
5. **Giữ accessibility & selector kiểm thử:** Giữ `dialog` đóng bằng `Esc`, focus management, thuộc tính `aria-*`, và các class/id đang được browser tests neo tới (`.setup-source select`, `.setup-calendar-fields`, `#project-heading`, `#schedule-proposal`, `dialog[open]`).

---

## 5. Quy ước Design System (`frontend/src/index.css`)

- **Dùng biến trong `:root`**, tránh hardcode mã màu mới rải rác: `--canvas`, `--rail`, `--panel`, `--raised`, `--inset`, `--line`, `--accent`, `--success`, `--warning`, `--danger`.
- **Phân cấp nút:** Mỗi vùng hành động chính tối đa **1 nút `.button.primary`**; thao tác phụ dùng `.button`, `.button.quiet`, hoặc `.text-link`.
- **Chọn mẫu hiển thị theo ngữ cảnh:**
  - *Form ngắn / cài đặt:* Modal `<dialog>`.
  - *Giải thích kèm đối chiếu Gantt:* Side Drawer bên phải.
  - *Sửa nhanh lặp lại (tên, số ngày, người phụ trách, trạng thái):* Inline ngay trên bảng.

---

## 6. Danh sách việc gợi ý cho người làm UI (UI Polish)

- **Gọn header `.project-bar` ở độ phân giải 1280px–1366px:** Gom nhóm 3 nút `Dự án mới` / `Xuất JSON` / `Nhập JSON` (ví dụ menu thả `Tệp dự án` hoặc nhóm icon+text thích ứng) để tên dự án dài không đẩy thanh header xuống 2 hàng chật chội.
- **Cải thiện nhịp thị giác (spacing, contrast, typography):** Tinh chỉnh độ thoáng giữa bảng, biểu đồ Gantt swimlane, thẻ Kanban và side drawer mà không đổi luồng chức năng.
- **Responsive tablet/mobile:** Rà soát cuộn ngang bảng dữ liệu, bảng Gantt và vị trí sticky action bar.

---

## 7. Quy trình bàn giao & Checklist duyệt PR giao diện

1. **Luôn tách nhánh từ bản mới nhất đã đồng bộ** trên remote (không làm UI trên nhánh cũ).
2. **Chạy đủ kiểm chứng trước khi tạo/duyệt PR:**
   - Từ `frontend/`: `npm run build`
   - Từ `frontend/` (PowerShell, chạy tuần tự với Edge):
     ```powershell
     $env:CONSTRAINTLENS_TEST_BROWSER = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
     node --test --test-concurrency=1
     ```
     *(Phải đạt toàn bộ 88/88 tests, 0 fail, 0 skip.)*
   - Từ gốc repo: `uv run --locked python -m unittest discover -s tests` *(phải pass toàn bộ backend tests).*
3. **Đính kèm ảnh chụp màn hình** (desktop rộng ≥1440px và laptop 1280px) trong PR để người UX đối chiếu đủ 5 trạng thái trước khi merge.
