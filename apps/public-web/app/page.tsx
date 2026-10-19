import { getSpaces } from "../lib/api";
import { LandingExperience } from "../components/LandingExperience";

export default async function HomePage() {
  const { spaces } = await getSpaces();
  return <LandingExperience spaces={spaces} />;
}
