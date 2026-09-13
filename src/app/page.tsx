import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/sessions";

// Root entry point. There is no public marketing page — send people straight to where they belong:
// a valid session lands in the dashboard, otherwise the passkey login (which honours ?next=).
export default async function Home() {
  const cookieStore = await cookies();
  const sid = cookieStore.get("aem_session")?.value;
  if (sid && (await getSession(sid))) redirect("/dashboard");
  redirect("/auth/login");
}
