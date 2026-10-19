import { getSpaces } from "../../lib/api";
import { CatalogueClient } from "../../components/CatalogueClient";

export default async function SpacesPage({
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
    <CatalogueClient
      initialSpaces={spaces}
      initialCategory={pick("category")}
      initialQuery={pick("q")}
      initialDate={pick("date")}
      initialStart={pick("start_time") || pick("start")}
      initialEnd={pick("end_time") || pick("end")}
    />
  );
}
