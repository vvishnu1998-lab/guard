const API_URL = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:3001';

export async function fetchApi(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}
