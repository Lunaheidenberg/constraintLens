import { formatDate } from "./calendar";
import type { assessDeadline } from "./plans";

export function DeadlineWarning({ assessment, accepted, onRevise }: {
  assessment: NonNullable<ReturnType<typeof assessDeadline>>;
  accepted?: boolean;
  onRevise: () => void;
}) {
  const { deadline, finalDate, daysLate } = assessment;
  return (
    <div className="notice warning space-y-2">
      <div role="status">
        <p className="font-semibold">{accepted ? "Lịch đang áp dụng không đáp ứng hạn chót" : "Kế hoạch không đáp ứng hạn chót"}</p>
        <p>Hạn chót <time dateTime={deadline}>{formatDate(deadline)}</time> · {accepted ? "Hoàn thành theo lịch" : "Hoàn thành theo đề xuất"} <time dateTime={finalDate}>{formatDate(finalDate)}</time> · Trễ {daysLate} ngày</p>
        <p>{accepted ? "Lịch này vẫn được giữ. Hãy điều chỉnh kế hoạch và lập lịch lại."
          : "Bạn chỉ có thể chấp nhận lịch đáp ứng hạn chót. Hãy điều chỉnh kế hoạch và lập lịch lại."}</p>
      </div>
      <button type="button" className="button primary" onClick={onRevise}>Điều chỉnh kế hoạch</button>
    </div>
  );
}
