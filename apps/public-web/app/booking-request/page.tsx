import { getSpaces } from "../../lib/api";
import { ConciergeInquiryForm } from "../../components/ConciergeInquiryForm";

export default async function BookingRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { spaces } = await getSpaces();

  const pick = (key: string) => {
    const val = params[key];
    return typeof val === "string" ? val : Array.isArray(val) ? val[0] ?? "" : "";
  };

  return (
    <ConciergeInquiryForm
      spaces={spaces}
      initialSpaceCode={pick("space") || pick("space_code")}
      initialDate={pick("date")}
      initialStart={pick("start") || pick("start_time")}
      initialEnd={pick("end") || pick("end_time")}
    />
  );
}
