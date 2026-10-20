import { notFound } from "next/navigation";
import { randomBytes } from "node:crypto";
import { getSpace } from "../../../../lib/api";
import { UnifiedRequestForm } from "../../../../components/UnifiedRequestForm";

export default async function RequestSpacePage({params}:{params:Promise<{code:string}>}){
  const {code}=await params;const space=await getSpace(code);if(!space)notFound();
  return <UnifiedRequestForm space={space} formToken={randomBytes(24).toString('base64url')}/>;
}
