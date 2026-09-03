export async function dnsTxtLookup(domain: string): Promise<string[]> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { Answer?: Array<{ data: string }> };
    return (data.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, ''));
  } catch {
    return [];
  }
}
