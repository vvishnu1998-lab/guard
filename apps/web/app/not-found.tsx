import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[#1A1A2E] flex flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-6xl font-bold tracking-widest text-amber-400">404</h1>
      <p className="text-gray-400 tracking-widest text-sm">PAGE NOT FOUND</p>
      <Link
        href="/"
        className="border border-amber-400 text-amber-400 px-6 py-2 rounded-lg tracking-widest hover:bg-amber-400 hover:text-gray-900 transition-colors text-sm"
      >
        GO HOME
      </Link>
    </main>
  );
}
