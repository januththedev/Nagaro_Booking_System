import { randomBytes } from "node:crypto";
import { getSpaces } from "../../lib/api";
import { DirectBookingForm } from "../../components/DirectBookingForm";

export default async function BookPage({
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

  const formToken = randomBytes(24).toString("base64url");

  return (
    <DirectBookingForm
      spaces={spaces}
      initialSpaceCode={pick("space") || pick("space_code")}
      initialDate={pick("date")}
      initialStart={pick("start") || pick("start_time")}
      initialEnd={pick("end") || pick("end_time")}
      initialDesks={pick("desks") || "1"}
      initialFormToken={formToken}
    />
  );
}
